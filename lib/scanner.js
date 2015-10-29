'use strict';

var util = require('util'),
    mdns = require('mdns'),
    events = require('events'),
    logger = require('./logger'),
    CastDevice = require('./device');

function Scanner(options) {
  var self = this,
      family = options.family || 0, // UNSPEC, can also use 4 or 6.
      sequence = [
        mdns.rst.DNSServiceResolve(),
        'DNSServiceGetAddrInfo' in mdns.dns_sd ? mdns.rst.DNSServiceGetAddrInfo() : mdns.rst.getaddrinfo({families:[family]}),
        mdns.rst.makeAddressesUnique()
      ];
  events.EventEmitter.call(this);
  options = options || {};
  this.logger = options.logger || logger.devnull;
  this.timeout = options.timeout || 5000;
  this.reconnect = options.reconnect || {};
  this.browser = mdns.createBrowser(mdns.tcp('googlecast'),
                                    {resolverSequence: sequence});
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
      self.logger.info('New device discovered but missing some mandatory information',
                       device);
      return;
    }
    // Usually, Chromecast device are using IPv4 only.
    if (self.devices[device.txtRecord.id]) {
      self.logger.debug('Already online device appeared', device);
      return;
    }
    var c = new CastDevice({
      friendlyName: device.txtRecord.fn,
      address: device.addresses[0],
      port: device.port,
      id: device.txtRecord.id,
      logger: self.logger,
      timeout: self.timeout,
      reconnect: self.reconnect
    });
    self.devices[c.id] = c;
    self.emit('online', c);
  }
  function onServiceDown(device) {
    var id = (device.txtRecord || {}).id;
    if (!self.devices[id]) {
      self.logger.debug('Unknown device has disappeared', device);
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
