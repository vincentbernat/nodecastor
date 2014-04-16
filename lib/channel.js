'use strict';

// Implementation of the cast channel protocol as a stream. We are
// using several layer of streams to decode the protocol
// incrementally.

var tls    = require('tls'),
    stream = require('stream'),
    util   = require('util'),
    path   = require('path'),
    events = require('events'),
    buffer = require('buffer'),
    tap    = require('tap-stream'),
    proto  = require('./proto');

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

function CastChannel(options) {
  stream.Duplex.call(this, { objectMode: true,
                             allowHalfOpen: false });

  if (typeof options.rejectUnauthorized === 'undefined') {
    options.rejectUnauthorized = false;
  }
  if (typeof options.heartbeat === 'undefined') {
    options.heartbeat = 30 * 1000;
  }
  var tlsStream = tls.connect(options),
      self = this,
      debug1 = options.debug?tap(0):(new stream.PassThrough({ objectMode: true })),
      debug2 = options.debug?tap(0):(new stream.PassThrough({ objectMode: true })),
      name = randomString(10);

  this
    .on('finish', function() {
      self.inRStream.end();
    })
    .on('error', function(err) {
      self.outWStream.end();
    });

  function propagateError(err) {
    self.emit('error', err);
  }

  var heartbeatMessageCodec = new HeartbeatMessageCodec({ timeout: options.heartbeat }),
      authMessageCodec = new AuthMessageCodec();

  this.inRStream = new stream.PassThrough({ objectMode: true });
  this.inRStream
    .pipe(new ConnectionMessageEncoder())
    .on('connected', function() { self.emit('connected'); })
    .on('error', propagateError)
    .pipe(heartbeatMessageCodec.encoder)
    .on('error', propagateError)
    .pipe(authMessageCodec.encoder)
    .on('error', propagateError)
    .pipe(new JsonCastMessageEncoder({ name: name }))
    .on('error', propagateError)
    .pipe(debug1)
    .pipe(new PlainCastMessageEncoder())
    .on('error', propagateError)
    .pipe(tlsStream)
    .on('error', propagateError);
  this.outWStream = tlsStream
    .on('error', propagateError)
    .pipe(new PlainCastMessageDecoder())
    .on('error', propagateError)
    .pipe(debug2)
    .pipe(new JsonCastMessageDecoder({ name: name }))
    .on('error', propagateError)
    .pipe(authMessageCodec.decoder)
    .on('error', propagateError)
    .pipe(heartbeatMessageCodec.decoder)
    .on('pong', function() { self.emit('pong'); })
    .on('error', propagateError)
    .pipe(new ConnectionMessageDecoder())
    .on('error', propagateError);
}
util.inherits(CastChannel, stream.Duplex);

CastChannel.prototype._write = function(chunk, enc, done) {
  this.inRStream.write(chunk, enc, done);
};

CastChannel.prototype._read = function(size) {
  var self = this;
  self.outWStream
    .on('readable', function() {
      var chunk;
      while (null !== (chunk = self.outWStream.read(size))) {
        if (!self.push(chunk)) break;
      }
    })
    .on('end', function() {
      self.push(null);
    });
};

// STEP 1: the protocol has a 4 bytes header which is the size of a
// CastMessage protobuf which comes just after. In this step, we
// transform the bytes into CastMessage protobuf objects.

function PlainCastMessageDecoder() {
  stream.Transform.call(this, { allowHalfOpen: false });
  this._writableState.objectMode = false;
  this._readableState.objectMode = true;
  this._buffers = [];
  this._headerBytes = 0;
  this._remainingLength = 0;
}
util.inherits(PlainCastMessageDecoder, stream.Transform);

PlainCastMessageDecoder.prototype._transform = function(chunk, enc, done) {
  while (chunk.length > 0) {
    if (this._headerBytes < 4) {
      // We need to get more header bytes
      var h = chunk.slice(0, 4 - this._headerBytes);
      chunk = chunk.slice(4 - this._headerBytes);
      this._buffers.push(h);
      this._headerBytes += h.length;
      if (this._headerBytes === 4) {
        var len = buffer.Buffer.concat(this._buffers).readUInt32BE(0);
        if (len > 65535) {
          this.emit('error', new Error('too large buffer to be received'));
          this.end();
          return;
        }
        this._remainingLength = len;
        this._buffers = [];
      }
    }

    if (this._headerBytes === 4 && this._remainingLength > 0) {
      // We need to get more body bytes
      var d = chunk.slice(0, this._remainingLength);
      chunk = chunk.slice(this._remainingLength);
      this._buffers.push(d);
      this._remainingLength -= d.length;
      if (this._remainingLength === 0) {
        var encoded = buffer.Buffer.concat(this._buffers),
            decoded;
        try {
          decoded = proto.CastMessage.decode(encoded);
        } catch (err) {
          this.emit('error', err);
          return;
        }
        this.push(decoded);
        this._buffers = [];
        this._headerBytes = 0;
      }
    }
  }
  done();
};

function PlainCastMessageEncoder() {
  stream.Transform.call(this, { allowHalfOpen: false });
  this._writableState.objectMode = true;
  this._readableState.objectMode = false;
}
util.inherits(PlainCastMessageEncoder, stream.Transform);

PlainCastMessageEncoder.prototype._transform = function(chunk, enc, done) {
  var data = chunk.encode().toBuffer(),
      header = new buffer.Buffer(4);
  header.writeUInt32BE(data.length, 0);
  this.push(header);
  this.push(data);
  done();
};

// STEP 2: the CastMessage protobuf messages are transformed into
// simpler JSON messages. This is just a convenience to avoid building
// CastMessage from the ground.


// Use JSON instead of protobuf
function JsonCastMessageDecoder(options) {
  stream.Transform.call(this, { objectMode: true,
                                allowHalfOpen: false });
  this._name = 'sender-' + (options.name || 'nodecastor');
}
util.inherits(JsonCastMessageDecoder, stream.Transform);

JsonCastMessageDecoder.prototype._transform = function(chunk, enc, done) {
  var result = {
    namespace: chunk.namespace
  };
  if (chunk.protocol_version != proto.CastMessage.ProtocolVersion.CASTV2_1_0) {
    this.emit('error', new Error('received a non castv2 1.0 message'));
    return;
  }
  result.source = chunk['source_id'];
  result.destination = chunk['destination_id'];
  if (chunk.payload_type === proto.CastMessage.PayloadType.BINARY) {
    result.data = chunk.payload_binary;
  } else {
    try {
      result.data = JSON.parse(chunk.payload_utf8);
    } catch (err) {
      this.emit('error', 'unable to parse JSON answer');
      return;
    }
  }
  this.push(result);
  done();
};

function JsonCastMessageEncoder(options) {
  stream.Transform.call(this, { objectMode: true,
                                allowHalfOpen: false });
  this._name = 'sender-' + (options.name || 'nodecastor');
}
util.inherits(JsonCastMessageEncoder, stream.Transform);

JsonCastMessageEncoder.prototype._transform = function(chunk, enc, done) {
  var namespace = chunk.namespace,
      data = chunk.data,
      message = new proto.CastMessage({
    'protocol_version': 'CASTV2_1_0',
    'source_id': chunk.source || this._name,
    'destination_id': chunk.destination || 'receiver-0',
    'namespace': chunk.namespace
  });
  if (buffer.Buffer.isBuffer(data)) {
    message.payload_type = 'BINARY';
    message.payload_binary = data;
  } else {
    message.payload_type = 'STRING';
    message.payload_utf8 = JSON.stringify(data);
  }
  this.push(message);
  done();
};

// STEP 3: we now need to open ask for the Chromecast for an
// authentication challenge just after opening the connection. The
// Chromecast will answer the challenge with some crypto stuff. We
// don't really care much if it is right or not.

function AuthMessageCodec() {

  function AuthMessageDecoder() {
    stream.Transform.call(this, { objectMode: true,
                                  allowHalfOpen: false });
  }
  util.inherits(AuthMessageDecoder, stream.Transform);

  AuthMessageDecoder.prototype._transform = function(chunk, enc, done) {
    if (chunk.namespace === 'urn:x-cast:com.google.cast.tp.deviceauth') {
      // We intercept those messages for own usage
      if (chunk.data === null) {
        this.emit('error', new Error('authentication message has no payload'));
        this.end();
        return;
      }
      var auth;
      try {
        auth = proto.DeviceAuthMessage.decode(chunk.data);
      } catch (err) {
        this.emit('error', err);
        this.end();
        return;
      }
      if (auth.error !== null) {
        this.emit('error', new Error('authentication error'));
        this.end();
        return;
      }
      if (auth.response === null) {
        this.emit('error', new Error('no authentication answer'));
        this.end();
        return;
      }
      // Don't check further, we don't care
      codec.ready.emit('ready');
      done();
    } else {
      this.push(chunk);
      done();
    }
  };

  function AuthMessageEncoder() {
    stream.Transform.call(this, { objectMode: true,
                                  allowHalfOpen: false });
    this._authenticated = false;
  }
  util.inherits(AuthMessageEncoder, stream.Transform);

  AuthMessageEncoder.prototype._transform = function(chunk, enc, done) {
    var self = this;
    if (!this._authenticated) {
      var auth = new proto.DeviceAuthMessage({
        "challenge": {}
      });
      this.push({
        namespace: 'urn:x-cast:com.google.cast.tp.deviceauth',
        data: auth.encode().toBuffer()
      });
      codec.ready.once('ready', function() {
        self._authenticated = true;
        self.push(chunk);
        done();
      });
    } else {
      self.push(chunk);
      done();
    }
  };

  var codec = this;
  this.encoder = new AuthMessageEncoder();
  this.decoder = new AuthMessageDecoder();
  this.ready = new events.EventEmitter();
}

// STEP 4: we send heartbeats at regular interval and check we receive them

function HeartbeatMessageCodec(options) {

  function HeartbeatMessageDecoder() {
    stream.Transform.call(this, { objectMode: true,
                                  allowHalfOpen: false });
    this._reset();
    var self = this;
    this.on('finish', function() { clearTimeout(self._timer); });
    this.on('end', function() { clearTimeout(self._timer); });
  }
  util.inherits(HeartbeatMessageDecoder, stream.Transform);

  HeartbeatMessageDecoder.prototype._transform = function(chunk, enc, done) {
    if (chunk.namespace === urn &&
        chunk.data.type === 'PONG') {
      this.emit('pong');
      this._reset();
      done();
    } else if (chunk.namespace === urn &&
               chunk.data.type === 'PING') {
      codec.encoder.push({
        namespace: urn,
        data: { type: 'PONG' },
        source: chunk.destination,
        destination: chunk.source
      });
      done();
    } else {
      this.push(chunk);
      done();
    }
  };

  HeartbeatMessageDecoder.prototype._deadline = function() {
    this.emit('error', new Error('no heartbeat received'));
    this._reset();
    return;
  };

  HeartbeatMessageDecoder.prototype._reset = function() {
    var self = this;
    if (this._timer) {
      clearTimeout(this._timer);
    }
    this._timer = setTimeout(function() { self._deadline(); },
                             options.timeout*1.2);
  };

  function HeartbeatMessageEncoder() {
    stream.Transform.call(this, { objectMode: true,
                                  allowHalfOpen: false });
    var self = this;
    this._timer = setInterval(function() { self._ping(); },
                              options.timeout);
    this.on('finish', function() { clearTimeout(self._timer); });
    this.on('end', function() { clearTimeout(self._timer); });
    this._ping();
  }
  util.inherits(HeartbeatMessageEncoder, stream.Transform);

  HeartbeatMessageEncoder.prototype._transform = function(chunk, enc, done) {
    this.push(chunk);
    done();
  };

  HeartbeatMessageEncoder.prototype._ping = function() {
    this.push({
      namespace: urn,
      data: { type: 'PING' }
    });
  };

  var urn = 'urn:x-cast:com.google.cast.tp.heartbeat',
      codec = this;
  this.decoder = new HeartbeatMessageDecoder();
  this.encoder = new HeartbeatMessageEncoder();
}

// STEP 5: we add the connection layer on top of that

function ConnectionMessageEncoder() {
  stream.Transform.call(this, { objectMode: true,
                                allowHalfOpen: false });
  this._connected = false;
  this._reqId = 100;
}
util.inherits(ConnectionMessageEncoder, stream.Transform);

ConnectionMessageEncoder.prototype._transform = function(chunk, enc, done) {
  if (!this._connected) {
    this.push({
      namespace: 'urn:x-cast:com.google.cast.tp.connection',
      data: { type: 'CONNECT',
              origin: {}
            }
    });
    this.emit('connected');
    this._connected = true;
  }
  if (typeof chunk.data.requestId === 'undefined') {
    chunk.data.requestId = this._reqId++;
  }
  this.push(chunk);
  done();
};

ConnectionMessageEncoder.prototype._flush = function(done) {
  this.push({
    namespace: 'urn:x-cast:com.google.cast.tp.connection',
    data: { type: 'CLOSE' }
  });
  done();
};

function ConnectionMessageDecoder() {
  stream.Transform.call(this, { objectMode: true,
                                allowHalfOpen: false });
}
util.inherits(ConnectionMessageDecoder, stream.Transform);

ConnectionMessageDecoder.prototype._transform = function(chunk, enc, done) {
  if (chunk.namespace === 'urn:x-cast:com.google.cast.tp.connection' &&
      chunk.data.type === 'CLOSE') {
    this.end();
    done();
  } else {
    this.push(chunk);
    done();
  }
};

module.exports = CastChannel;
