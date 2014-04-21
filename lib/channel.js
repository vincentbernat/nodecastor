'use strict';

// Implementation of the cast channel protocol.

var tls    = require('tls'),
    util   = require('util'),
    path   = require('path'),
    events = require('events'),
    buffer = require('buffer'),
    _      = require('lodash'),
    uniq   = require('./uniq'),
    proto  = require('./proto'),
    logger = require('./logger');

// Provide a random string
function randomString(length) {
  var bits = 36,
      tmp,
      out = "";
  while (out.length < length) {
    tmp = Math.random().toString(bits).slice(2);
    out += tmp.slice(0, Math.min(tmp.length, (length - out.length)));
  }
  return out.toUpperCase();
};

// Log some protobuf message
function logtap(logger, message, data) {
  data = _.clone(data);
  if (data.payload_binary !== null) {
    data.payload_binary = '... (' + data.payload_binary.length + ' bytes)';
  }
  logger.debug(message, data);
};

function CastChannel(options) {
  events.EventEmitter.call(this);

  if (typeof options.rejectUnauthorized === 'undefined') {
    options.rejectUnauthorized = false;
  }
  if (typeof options.heartbeat === 'undefined') {
    options.heartbeat = 30 * 1000;
  }
  this.logger = options.logger || logger.devnull;
  this.name = 'sender-' + randomString(10);
  this.authenticated = false;
  this.disconnecting = false;

  var tlsStream = tls.connect(options),
      self = this;

  tlsStream
    .on('readable', readable)
    .on('end', close)
    .on('close', close)
    .on('finish', close)
    .on('error', error)
    .on('secureConnect', connect);

  // Send heartbeat at regular interval
  var heartbeat = (function() {
    var timer = null;

    function deadline() {
      self.logger.debug('Heartbeat missed, end connection');
      self.end(new Error('missed heartbeat'));
    }

    function send() {
      self.write({
        namespace: 'urn:x-cast:com.google.cast.tp.heartbeat',
        data: { type: 'PING' }
      });
      timer = setTimeout(deadline, 5000);
    }

    return {
      setup: function() {
        send();
      },
      received: function() {
        clearTimeout(timer);
        timer = setTimeout(send, options.heartbeat);
      },
      tearDown: function() {
        if (timer) {
          clearTimeout(timer);
        }
      }
    };
  })();
  this.once('connect', heartbeat.setup);

  function cleanup() {
    heartbeat.tearDown();
    this.removeListener('connect', heartbeat.setup);
    tlsStream.removeListener('readable', readable);
    tlsStream.removeListener('end', close);
    tlsStream.removeListener('close', close);
    tlsStream.removeListener('finish', close);
    // tlsStream.removeListener('error', error);
    tlsStream.removeListener('secureConnect', connect);
    tlsStream.end();
  }

  function readable() {
    var data;
    data = self.codec.to.protobuf.call(self, this);
    if (!data) return;

    logtap(self.logger, 'Received from Chromecast', data);

    data = self.codec.to.json.call(self, data);
    if (!data) return;

    data = self.codec.to.auth.call(self, data);
    if (!data) return;

    data = self.codec.to.heartbeat.call(self, data, heartbeat.received);
    if (!data) return;

    self.emit('message', data);
  }

  function write(data) {
    // Nothing to do for heartbeats

    data = this.codec.from.auth.call(this, data);
    if (!data) return;

    data = this.codec.from.json.call(this, data);
    if (!data) return;

    logtap(self.logger, 'Sent to Chromecast', data);

    data = this.codec.from.protobuf.call(this, data);
    if (!data) return;

    tlsStream.write(data);
  }

  function close() {
    self.end();
  }

  function error(err) {
    self.end(err);
  }

  function connect() {
    self.logger.debug('TLS connection established');
    var auth = new proto.DeviceAuthMessage({
        challenge: {}
    });
    self.write({
      namespace: 'urn:x-cast:com.google.cast.tp.deviceauth',
      data: auth.encode().toBuffer()
    });
  };

  this.cleanup = cleanup;
  this.write = write;
}
util.inherits(CastChannel, events.EventEmitter);

// End connection to Chromecast, optionally with an error.
CastChannel.prototype.end = function(err) {
  if (this.disconnecting) {
    return;
  }

  this.disconnecting = true;
  if (err) {
    this.logger.debug('Got an error:', err.message);
    this.emit('error', err);
  }
  this.logger.debug('Tear off stream to Chromecast');
  this.cleanup();
  this.emit('disconnect');
};

// Send data using a session and wait for an optional answer. The
// callback and timeout are optional.
CastChannel.prototype.send = function(data, cb, timeout) {
  var self = this,
      timer = null,
      id = uniq();

  // Switch to the appropriate session
  if (this._currentSession !== (data.destination || 'default')) {
    this.write({
      namespace: 'urn:x-cast:com.google.cast.tp.connection',
      data: {
        type: 'CONNECT',
        origin: {}
      },
      destination: data.destination
    });
    this._currentSession = (data.destination || 'default');
  }

  // Send data
  data = _.cloneDeep(data);
  data.data.requestId = id;
  this.write(data);

  if (cb) {
    // Invoked when we get an answer
    var answer = function(message) {
      if (message.namespace === data.namespace &&
          message.data.requestId === data.data.requestId) {
        if (timer) {
          clearTimeout(timer);
        }
        self.removeListener('message', answer);
        self.removeListener('disconnect', cancel);
        cb(null, message);
      }
    };

    var cancel = function() {
      self.removeListener('message', answer);
      if (timer) {
        clearTimeout(timer);
      }
      cb(new Error('disconnected from Chromecast device'));
    };

    if (timeout) {
      timer = setTimeout(function() {
        self.removeListener('message', answer);
        self.removeListener('disconnect', cancel);
        cb(new Error('no answer from Chromecast device'));
      }, timeout);
    }
    this.on('message', answer);
    this.on('disconnect', cancel);
  }
};

CastChannel.prototype.codec = {};
CastChannel.prototype.codec.to = {};
CastChannel.prototype.codec.from = {};

// STEP 1: the protocol has a 4 bytes header which is the size of a
// CastMessage protobuf which comes just after. In this step, we
// transform the bytes into CastMessage protobuf objects.

CastChannel.prototype.codec.to.protobuf = function(source) {
  // Read the header
  if (!this._buflen) {
    var header = source.read(4);
    if (!header) return undefined;       // Not enough data available.
    var len = header.readUInt32BE(0);
    if (len > 65535) {
      this.end(new Error('toot large buffer to be received'));
      return undefined;
    }
    this._buflen = len;
  }

  // Read the raw bytes
  var data = source.read(this._buflen);
  if (!data) {
    return undefined;
  }
  this._buflen = null;

  // Decode as protobuf
  var decoded;
  try {
    decoded = proto.CastMessage.decode(data);
  } catch (err) {
    this.end(err);
    return undefined;
  }
  return decoded;
};

CastChannel.prototype.codec.from.protobuf = function(source) {
  var data = source.encode().toBuffer(),
      header = new buffer.Buffer(4);
  header.writeUInt32BE(data.length, 0);
  return buffer.Buffer.concat([header, data]);
};

// STEP 2: the CastMessage protobuf messages are transformed into
// simpler JSON messages. This is just a convenience to avoid building
// CastMessage from the ground.

CastChannel.prototype.codec.to.json = function(source) {
  var result = {
    namespace: source.namespace
  };
  if (source.protocol_version != proto.CastMessage.ProtocolVersion.CASTV2_1_0) {
    self.end(new Error('received a non CASTv2 1.0 message'));
    return undefined;
  }
  result.source = source['source_id'];
  result.destination = source['destination_id'];
  if (source.payload_type === proto.CastMessage.PayloadType.BINARY) {
    result.data = source.payload_binary;
  } else {
    if (source.payload_utf8[0] === '{') {
      try {
        result.data = JSON.parse(source.payload_utf8);
      } catch (err) {
        self.send(new Error('unable to parse JSON answer'));
        return undefined;
      }
    } else {
      result.data = source.payload_utf8;
    }
  }
  return result;
};

CastChannel.prototype.codec.from.json = function(source) {
  var namespace = source.namespace,
      data = source.data,
      message = new proto.CastMessage({
        'protocol_version': 'CASTV2_1_0',
        'source_id': source.source || this.name,
        'destination_id': source.destination || 'receiver-0',
        'namespace': source.namespace
      });
  if (buffer.Buffer.isBuffer(data)) {
    message.payload_type = 'BINARY';
    message.payload_binary = data;
  } else {
    message.payload_type = 'STRING';
    message.payload_utf8 = (typeof data === 'string')?data:JSON.stringify(data);
  }
  return message;
};

// STEP 3: we now need to open ask for the Chromecast for an
// authentication challenge just after opening the connection. The
// Chromecast will answer the challenge with some crypto stuff. We
// don't really care much if it is right or not.

CastChannel.prototype.codec.to.auth = function(source) {
  if (source.namespace === 'urn:x-cast:com.google.cast.tp.deviceauth') {
    if (this.authenticated) {
      this.end(new Error('authentication data while already authenticated'));
      return undefined;
    }
    var auth;
    try {
      auth = proto.DeviceAuthMessage.decode(source.data);
    } catch (err) {
      this.end(err);
      return undefined;
    }
    if (auth.error !== null) {
      this.end(new Error('authentication error'));
      return undefined;
    }
    if (auth.response === null) {
      this.end(new Error('no authentication data in answer'));
      return undefined;
    }
    this.logger.debug('Authentication successful');
    this.authenticated = true;
    this.emit('connect');       // We are successfully connected
    return undefined;
  } else if (!this.authenticated) {
    this.end(new Error('received data while authentication was not done'));
    return undefined;
  } else {
    // Already authenticated, just pass data
    return source;
  }
};

CastChannel.prototype.codec.from.auth = function(source) {
  if (!this.authenticated) {
    if (source.namespace === 'urn:x-cast:com.google.cast.tp.deviceauth') {
      return source;
    } else {
      this.end(new Error('trying to transmit non auth related stuff while not authenticated'));
      return undefined;
    }
  } else {
    if (source.namespace === 'urn:x-cast:com.google.cast.tp.deviceauth') {
      this.end(new Error('trying to transmit auth related stuff while already authenticated'));
      return undefined;
    } else {
      return source;
    }
  }
};

// STEP 4: We send heartbeats at regular interval and check we receive
// them. We also answer heartbeats we receive.

CastChannel.prototype.codec.to.heartbeat = function(source, cb) {
  var urn =  'urn:x-cast:com.google.cast.tp.heartbeat';
  if (source.namespace === urn &&
      source.data.type === 'PONG') {
    cb();
    return undefined;
  }
  if (source.namespace === urn &&
      source.data.type === 'PING') {
    this.write({
      namespace: urn,
      data: { type: 'PONG' },
      source: source.destination,
      destination: source.source
    });
    return undefined;
  }
  return source;
};

module.exports = CastChannel;
