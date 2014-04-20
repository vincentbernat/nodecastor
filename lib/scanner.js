'use strict';

var util = require('util'),
    mdns = require('mdns2'),
    events = require('events'),
    logger = require('./logger'),
    CastDevice = require('./device');

function Scanner(options) {
  var self = this;
  events.EventEmitter.call(this);
  this.logger = options.logger || logger.devnull;
  this.timeout = options.timeout || 5000;
  this.browser = mdns.createBrowser(mdns.tcp('googlecast'));
  this.browser
    .on('serviceUp', onServiceUp)
    .on('serviceDown', onServiceDown);
  this.devices = [];

  function onServiceUp(device) {
    if (!device.addresses ||
        device.addresses.length === 0 ||
        !device.name ||
        !device.port ||
        !device.txtRecord ||
        !device.txtRecord.fn ||
        !device.txtRecord.id) {
      this.logger.info('New device discovered but missing some mandatory information',
                       device);
      return;
    }
    // Usually, Chromecast device are using IPv4 only.
    var c = new CastDevice({
      friendlyName: device.txtRecord.fn,
      address: device.addresses[0],
      port: device.port,
      id: device.txtRecord.id,
      logger: this.logger,
      timeout: this.timeout
    });
    if (self.devices[c.id]) {
      this.logger.debug('Already online device appeared', device);
      return;
    }
    self.devices[c.id] = c;
    self.emit('online', c);
  }
  function onServiceDown(device) {
    var id = (device.txtRecord || {}).id;
    if (!self.devices[id]) {
      this.logger.debug('Unknown device has disappeared', device);
      return;
    }
    self.emit('offline', self.devices[id]);
    delete self.devices[id];
  }
}
util.inherits(Scanner, events.EventEmitter);

Scanner.prototype.start = function() {
  this.browser.start();
  return this;
};
Scanner.prototype.end = function() {
  this.browser.end();
  return this;
};

module.exports = Scanner;
