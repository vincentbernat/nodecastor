[![NPM version](https://badge.fury.io/js/nodecastor.png)](http://badge.fury.io/js/nodecastor)

This library is an experiment to provide a sender API for Google
Chromecast devices using mDNS and some TLS protobuf protocol instead
of the DIAL discovery protocol. Google
[recently switched away from DIAL][1]. While SSDP/DIAL support is
still present, existing applications have to migrate to the new SDK
using the new protocol.

This library doesn't support the DIAL discovery protocol. See
[nodecast][] instead.

[1]: https://plus.google.com/+SebastianMauer/posts/83hTniKEDwN
[nodecast]: https://github.com/wearefractal/nodecast

## Install

Install the library with `npm install nodecastor`.

## Usage

Here is a simple usage of this library

```javascript
var nodecastor = require('nodecastor'),
    d = nodecastor.discover();

d.on('device', function(device) {
  d.ping();
  d.once('pong', function() {
    console.log('PONG!');
    process.exit(0);
  });
}

d.start();
```

On Linux, if no device is discovered, first check that your machine is
able to do mDNS address resolution. The library used for this purpose
delegates this to the libc. You should have something like that in
`/etc/nsswitch.conf`:

    hosts: files mdns4_minimal [NOTFOUND=return] dns mdns4


## Command-line helper

The functionality of this library can be tested with the `chromecast`
helper. Invoke it with `chromecast -h` to get help.
