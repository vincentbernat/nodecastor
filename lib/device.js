'use strict';

var util = require('util'),
    events = require('events'),
    backoff = require('backoff'),
    logger = require('./logger'),
    uniq = require('./uniq'),
    CastChannel = require('./channel'),
    CastApplication = require('./application');

function CastDevice(options) {
  events.EventEmitter.call(this);

  var self = this;

  this.id = options.id;
  this.friendlyName = options.friendlyName;
  this.address = options.address || '127.0.0.1';
  this.port    = options.port || 8009;
  this.logger  = options.logger || logger.devnull;
  this.timeout = options.timeout || 5000;

  // Handling automatic reconnection
  this._stopped = false;        // Voluntary stop?
  if (options.reconnect !== false) {
    options.reconnect = options.reconnect || {};
    this._backoff = backoff.fibonacci({
      randomisationFactor: 0.2,
      initialDelay: options.reconnect.initialDelay || 100,
      maxDelay: options.reconnect.maxDelay || 10000
    });
    if ((options.reconnect.maxRetries || 10) !== Infinity) {
      this._backoff.failAfter(options.reconnect.maxRetries || 10);
    }
    this._backoff
      .on('ready', function() {
        if (!this._stopped) {
          self.connect();
        }
      })
      .on('fail', function() {
        self.emit('reconnect_failed');
      });
  }

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

  function disconnect() {
    if (!self._stopped) {
      if (self._backoff) {
        // Retry to connect
        self.logger.debug('Disconnected from device, try to reconnect');
        self._backoff.backoff();
      }
      self.emit('disconnect');
    }
  }

  this._stopped = false;
  this.channel
    .on('error', function(err) {
      self.emit('error', err);
    })
    .on('disconnect', function() {
      disconnect();
    })
    .once('connect', function() {
      if (this._backoff) {
        this._backoff.reset();
      }
      self.emit('connect');
    })
    .on('message', function(message) {
      if (message.namespace === 'urn:x-cast:com.google.cast.receiver' &&
          message.destination === '*' &&
          message.data.type === 'RECEIVER_STATUS') {
        self.emit('status', message.data.status);
      }
      self.emit('message', message);
    });
};

// End connection with the cast device.
CastDevice.prototype.stop = function() {
  this._stopped = true;
  this.channel.end();
};

// Get the current status of the device
CastDevice.prototype.status = function(cb) {
  var msg = {
    namespace: 'urn:x-cast:com.google.cast.receiver',
    data: { type: 'GET_STATUS' }
  };
  if (cb) {
    this.channel.send(msg, function(err, message) {
      if (err) {
        cb(err);
      } else {
        cb(null, message.data.status);
      }
    }, this.timeout);
  } else {
    this.channel.send(msg);
  }
};

// Get an available application
CastDevice.prototype.application = function(appId, cb) {
  var self = this,
      msg = {
        namespace: 'urn:x-cast:com.google.cast.receiver',
        data: { type: 'GET_APP_AVAILABILITY',
                appId: [ appId ] }
      };
  if (cb) {
    this.channel.send(msg, function(err, message) {
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
    }, this.timeout);
  } else {
    this.channel.send(msg);
  }
};

module.exports = CastDevice;
