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

  this.stream
    .on('error', function(err) {
      self.emit('error', err);
    })
    .on('end', function() {
      self.emit('disconnect');
    });
};

Chromecast.prototype.ping = function() {
  var self = this,
      urn = 'urn:x-cast:com.google.cast.tp.heartbeat';
  function pong() {
    var message = self.stream.read(1);
    if (!message) return;
    if (message.namespace === urn &&
        message.data.type === 'PONG') {
      self.emit('pong');
      self.stream.removeListener('pong', pong);
    }
  }
  this.stream.on('readable', pong);
  this.stream.write({
    namespace: urn,
    data: { type: 'PING' }
  });
};

Chromecast.prototype.status = function() {
  var self = this,
      urn = 'urn:x-cast:com.google.cast.receiver';
  function status() {
    var message = self.stream.read(1);
    if (!message) return;
    if (message.namespace === urn &&
        message.data.type === 'GET_STATUS') {
      self.emit('status', message.data.status);
      self.stream.removeListener('status', status);
    }
  }
  this.stream.on('readable', status);
  this.stream.write({
    namespace: urn,
    data: { type: 'GET_STATUS' }
  });
};

module.exports = Chromecast;
