'use strict';

var util = require('util'),
    events = require('events'),
    tls = require('tls'),
    _ = require('lodash'),
    path = require('path'),
    CastChannel = require('./channel');

function Chromecast(params) {
  events.EventEmitter.call(this);
  _.extend(this, params);
  this.connect();
}
util.inherits(Chromecast, events.EventEmitter);

Chromecast.prototype.connect = function() {
  var self = this;
  // We only implement secure cast streams
  this.stream = new CastChannel({
    host: this.address,
    port: this.port,
    debug: this.debug
  });

  this.stream
    .on('error', function(err) {
      self.emit('error', err);
    })
    .on('end', function() {
      self.emit('disconnect');
    })
    .on('readable', function() {
      var message = self.stream.read(1);
      if (message) {
        self.emit('message', message);
      }
    });
};

Chromecast.prototype.disconnect = function() {
  this.stream.end();
};

Chromecast.prototype.ping = function() {
  var self = this;
  this.stream.once('pong', function() {
      self.emit('pong');
  });
};

Chromecast.prototype.status = function() {
  var self = this,
      urn = 'urn:x-cast:com.google.cast.receiver';
  function status(message) {
    if (message.namespace === urn &&
        message.data.type === 'RECEIVER_STATUS') {
      self.emit('status', message.data.status);
      self.stream.removeListener('status', status);
    }
  }
  this.stream.write({
    namespace: urn,
    data: { type: 'GET_STATUS' }
  });
  this.on('message', status);
};

Chromecast.prototype.run = function(id) {
  var self = this,
      urn = 'urn:x-cast:com.google.cast.receiver';
  this.stream.write({
    namespace: urn,
    data: { type: 'LAUNCH', appId: id }
  });
};

module.exports = Chromecast;
