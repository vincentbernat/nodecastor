'use strict';

// Implementation of the cast channel protocol as a stream. We are
// using several layer of streams to decode the protocol
// incrementally.

var tls = require('tls'),
    stream = require('stream'),
    util = require('util'),
    path = require('path'),
    events = require('events'),
    buffer = require('buffer'),
    proto = require('./proto'),
    tap = require('tap-stream');

function CastChannel(options) {
  stream.Duplex.call(this, { objectMode: true,
                             allowHalfOpen: false });

  if (typeof options.rejectUnauthorized === 'undefined') {
    options.rejectUnauthorized = false;
  }
  var tlsStream = tls.connect(options),
      authReady = new events.EventEmitter(),
      self = this,
      debug1 = options.debug?tap(0):(new stream.PassThrough({ objectMode: true })),
      debug2 = options.debug?tap(0):(new stream.PassThrough({ objectMode: true }));

  this.inRStream = new stream.PassThrough({ objectMode: true });
  this.inRStream
    .pipe(new AuthCastMessageEncoder(authReady))
    .on('error', function(error) { self.emit('error', error); })
    .pipe(new JsonCastMessageEncoder())
    .on('error', function(error) { self.emit('error', error); })
    .pipe(debug1)
    .pipe(new PlainCastMessageEncoder())
    .on('error', function(error) { self.emit('error', error); })
    .pipe(tlsStream)
    .on('error', function(error) { self.emit('error', error); });
  this.outWStream = tlsStream
    .on('error', function(error) { self.emit('error', error); })
    .pipe(new PlainCastMessageDecoder())
    .on('error', function(error) { self.emit('error', error); })
    .pipe(debug2)
    .pipe(new JsonCastMessageDecoder())
    .on('error', function(error) { self.emit('error', error); })
    .pipe(new AuthCastMessageDecoder(authReady))
    .on('error', function(error) { self.emit('error', error); });
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
  stream.Transform.call(this, {});
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

PlainCastMessageDecoder.prototype._flush = function(cb) {
  this.emit('error', new Error('partial data received'));
};

function PlainCastMessageEncoder() {
  stream.Transform.call(this, {});
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
function JsonCastMessageDecoder() {
  stream.Transform.call(this, { objectMode: true });
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
  if (chunk.destination_id != 'sender-0') {
    this.emit('error', new Error('received a message not for us'));
    return;
  }
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

function JsonCastMessageEncoder() {
  stream.Transform.call(this, { objectMode: true });
}
util.inherits(JsonCastMessageEncoder, stream.Transform);

JsonCastMessageEncoder.prototype._transform = function(chunk, enc, done) {
  var namespace = chunk.namespace,
      data = chunk.data,
      message = new proto.CastMessage({
    'protocol_version': 'CASTV2_1_0',
    'source_id': 'sender-0',
    'destination_id': 'receiver-0',
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

function AuthCastMessageDecoder(authReady) {
  stream.Transform.call(this, { objectMode: true });
  this._authReady = authReady;
}
util.inherits(AuthCastMessageDecoder, stream.Transform);

AuthCastMessageDecoder.prototype._transform = function(chunk, enc, done) {
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
    this._authReady.emit('ready');
    done();
  } else {
    this.push(chunk);
  }
};

function AuthCastMessageEncoder(authReady) {
  stream.Transform.call(this, { objectMode: true });
  this._authenticated = false;
  this._authReady = authReady;
}
util.inherits(AuthCastMessageEncoder, stream.Transform);

AuthCastMessageEncoder.prototype._transform = function(chunk, enc, done) {
  var self = this;
  if (!this._authenticated) {
    var auth = new proto.DeviceAuthMessage({
      "challenge": {}
    });
    var message = new proto.CastMessage({
      'protocol_version': 'CASTV2_1_0',
      'source_id': 'sender-0',
      'destination_id': 'receiver-0',
      'namespace': 'urn:x-cast:com.google.cast.tp.deviceauth',
      'payload_type': 'BINARY',
      'payload_binary': auth.encode()
    });
    this.push({
      namespace: 'urn:x-cast:com.google.cast.tp.deviceauth',
      data: auth.encode().toBuffer()
    });
    this._authReady.once('ready', function() {
      self._authenticated = true;
      self.push(chunk);
      done();
    });
  } else {
    self.push(chunk);
    done();
  }
};

module.exports = CastChannel;
