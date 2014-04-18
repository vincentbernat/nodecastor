'use strict';

var util = require('util'),
    events = require('events'),
    logger = require('./logger'),
    uniq = require('./uniq'),
    CastChannel = require('./channel'),
    CastApplication = require('./application');

function CastDevice(options) {
  events.EventEmitter.call(this);

  this.id = options.id;
  this.friendlyName = options.friendlyName;
  this.address = options.address || '127.0.0.1';
  this.port = options.port || 8009;
  this.logger = options.logger || logger.devnull;
  this.timeout = options.timeout || 5000;

  this.connect();
}
util.inherits(CastDevice, events.EventEmitter);

// Connect to the cast device. Is called automatically by the
// constructor, should not be called manually.
CastDevice.prototype.connect = function() {
  var self = this;
  this.channel = new CastChannel({
    host: this.address,
    port: this.port,
    logger: this.logger
  });

  this.channel
    .on('error', function(err) {
      self.emit('error', err);
    })
    .on('end', function() {
      self.emit('disconnect');
    })
    .once('pong', function() {
      self.emit('connect');
    })
    .on('message', function(message) {
      self.emit('message', message);
    });
};

// End connection with the cast device.
CastDevice.prototype.stop = function() {
  this.channel.end();
};

// Get the current status of the device
CastDevice.prototype.status = function(cb) {
  this.channel.send({
    namespace: 'urn:x-cast:com.google.cast.receiver',
    data: { type: 'GET_STATUS' }
  }, function(err, message) {
    if (cb) {
      if (err) {
        cb(err);
      } else {
        cb(null, message.data.status);
      }
    }
  }, this.timeout);
};

// Get an available application
CastDevice.prototype.application = function(appId, cb) {
  var self = this;
  this.channel.send({
    namespace: 'urn:x-cast:com.google.cast.receiver',
    data: { type: 'GET_APP_AVAILABILITY',
            appId: [ appId ] }
  }, function(err, message) {
    if (cb) {
      if (err) {
        cb(err);
      } else {
        if (message.data.availability[appId] !== 'APP_AVAILABLE') {
          cb(new Error('requested application is not available'));
        } else {
          cb(null, new CastApplication(self, appId,
                                       { logger: self.logger,
                                         timeout: self.timeout }));
        }
      }
    }
  }, this.timeout);
};

module.exports = CastDevice;
