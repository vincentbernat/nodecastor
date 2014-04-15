'use strict';

var util = require('util'),
    events = require('events'),
    tls = require('tls'),
    _ = require('lodash'),
    path = require('path'),
    nodecastor = require('..'),
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

  this.stream.on('error', function(err) {
    self.emit('error', err);
  });
};

Chromecast.prototype.ping = function() {
  var self = this;
  this.stream.once('readable', function() {
    var message = self.stream.read(1);
    if (message.namespace === 'urn:x-cast:com.google.cast.tp.heartbeat' &&
        message.data.type === 'PONG') {
      self.emit('pong');
    }
  });
  this.stream.write({
    namespace: 'urn:x-cast:com.google.cast.tp.heartbeat',
    data: { type: 'PING' }
  });
};

module.exports = Chromecast;
