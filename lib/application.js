'use strict';

var util = require('util'),
    events = require('events'),
    _ = require('lodash'),
    logger = require('./logger'),
    CastSession = require('./session');

function CastApplication(device, id, options) {
  events.EventEmitter.call(this);

  this.device = device;
  this.id = id;

  options = options || {};
  this.timeout = options.timeout || 5000;
  this.logger = options.logger || logger.devnull;
}
util.inherits(CastApplication, events.EventEmitter);

// Run an application and get the appropriate session from it
CastApplication.prototype.run = function(namespace, cb) {
  var self = this,
      msg = {
        namespace: 'urn:x-cast:com.google.cast.receiver',
        data: { type: 'LAUNCH',
                appId: this.id }
      };
  if (cb) {
    this.device.channel.send(msg, function(err, message) {
      if (err) {
        cb(err);
        return;
      }
      // We get a RECEIVER_STATUS message
      if (message.data.type !== 'RECEIVER_STATUS') {
        cb(new Error('expected a RECEIVER_STATUS message'));
        return;
      }
      var status = message.data.status;
      // Check our application is running.
      var app = _.find(status.applications, { appId: self.id });
      if (!app) {
        cb(new Error('application hasn\'t been able to start'));
        return;
      }
      // Is the requested namespace present?
      if (namespace && !_.find(app.namespaces, { name: namespace })) {
        cb(new Error('requested namespace has not been found'));
        return;
      }
      self.logger.debug('Application seems to have been started successfully', app);
      cb(null, new CastSession(self.device, self,
                               namespace, app.transportId,
                               { logger: self.logger,
                                 timeout: self.timeout }));
    }, this.timeout);
  } else {
    this.device.channel.send(msg);
  }
};

// Join a running application
CastApplication.prototype.join = function(namespace, cb) {
  var self = this;

  // We need to get the transport ID
  this.device.status(function(err, status) {
    if (err) {
      if (cb) { cb(err); }
      return;
    }
    var app = _.find(status.applications, { appId: self.id });
    if (!app) {
      cb(new Error('application is not running'));
      return;
    }
    if (namespace && !_.find(app.namespaces, { name: namespace })) {
      cb(new Error('requested namespace has not been found'));
      return;
    }
    self.logger.debug('Requested application found running, attach to it');
    cb(null, new CastSession(self.device, self, namespace, app.transportId,
                             { logger: self.logger,
                               timeout: self.timeout }));
  });
};

module.exports = CastApplication;
