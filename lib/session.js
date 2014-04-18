'use strict';

var util = require('util'),
    events = require('events'),
    logger = require('./logger');

function CastSession(device, app, namespace, id, options) {
  events.EventEmitter.call(this);

  this.device = device;
  this.app = app;
  this.namespace = namespace;
  this.id = id;
  this.timeout = options.timeout || 5000;
  this.logger = options.logger || logger.devnull;

  // Emit messages for messages from this session
  var self = this;
  this.device.on('message', function(message) {
    if (message.source === this.id) {
      self.emit('message', message);
    }
  });
}
util.inherits(CastSession, events.EventEmitter);

// Send a message and optionally wait for an answer
CastSession.prototype.send = function(data, cb) {
  var datum = {
    namespace: this.namespace,
    destination: this.id,
    data: data
  };
  if (cb) {
    this.device.channel.send(datum, function(err, answer) {
      if (err) {
        cb(err);
      } else {
        cb(null, answer.data);
      }
    }, this.timeout);
  } else {
    this.device.channel.send(datum);
  }
};

// Close a session
CastSession.prototype.stop = function() {
  this.device.channel.stop(this.id);
};

module.exports = CastSession;
