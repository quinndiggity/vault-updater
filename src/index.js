/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

let Hapi = require('@hapi/hapi')
let StatsD = require('hot-shots')
let Boom = require('@hapi/boom')
let Joi = require('@hapi/joi')

process.env.NEW_RELIC_NO_CONFIG_FILE = true
if (process.env.NEW_RELIC_APP_NAME && process.env.NEW_RELIC_LICENSE_KEY) {
  var newrelic = require('newrelic')
} else {
  console.log("Warning: New Relic not configured!")
}

let logger = require('logfmt')
let Inert = require('inert')
let assert = require('assert')
let _ = require('underscore')

let profile = process.env.NODE_ENV || 'development'
let config = require('../config/config.' + profile + '.js')

let db = require('./db')
let setup = require('./setup')
let common = require('./common')
let mq = require('./mq')
let headers = require('./lib/headers')

// Read in the channel / platform releases meta-data
let releases = setup.readReleases('data')
let extensions = setup.readExtensions()

if (process.env.DEBUG) {
  console.log(_.keys(releases))
}

// setup connection to MongoDB
mq.setup((senders) => {
  // message queue senders for each product
  let muonSender = senders.muon
  let braveCoreSender = senders.braveCore

  db.setup(muonSender, braveCoreSender, (mongo) => {
    let runtime = {
      'mongo': mongo,
      'sender': muonSender
    }

    // POST, DEL and GET /1/releases/{platform}/{version}
    let releaseRoutes = require('./controllers/releases').setup(runtime, releases)
    let extensionRoutes = require('./controllers/extensions').setup(runtime, extensions)
    let crashes = require('./controllers/crashes').setup(runtime)
    let monitoring = require('./controllers/monitoring').setup(runtime)

    // GET /1/usage/[ios|android|brave-core]
    let androidRoutes = require('./controllers/android').setup(runtime)
    let iosRoutes = require('./controllers/ios').setup(runtime)
    let braveCoreRoutes = require('./controllers/braveCore').setup(runtime)

    // GET /1/installerEvent
    let installerEventsCollectionRoutes = require('./controllers/installer-events').setup(runtime)

    // promotional proxy
    let promoProxy = []
    if (process.env.FEATURE_REFERRAL_PROMO) {
      console.log("Configuring promo proxy [FEATURE_REFERRAL_PROMO]")
      promoProxy = require('./controllers/promo').setup(runtime, releases)
    }

    // webcompat collection routes
    let webcompatRoutes = require('./controllers/webcompat').setup(runtime, releases)

    const init = async () => {
      let server = null

      // Output request headers to aid in osx crash storage issue
      if (process.env.LOG_HEADERS) {
        server = new Hapi.Server({
          host: config.host,
          port: config.port,
          debug: {
            request: ['error', 'received', 'handler'],
            log: ['error']
          }
        })
      } else {
        server = new Hapi.Server({
          host: config.host,
          port: config.port,
        })
      }

      if (process.env.INSPECT_BRAVE_HEADERS) {
        server.events.on('request', (request, event, tags) => {
          headers.inspectBraveHeaders(request)
        })
      }
      server.validator(Joi)

      await server.register({ plugin: require('@hapi/h2o2'), options: { passThrough: true } })
      await server.register({ plugin: require('blipp') })
      // TODO(aubrey): was this being used?
      //await server.register({
      //  plugin: require('hapi-s3'),
      //  options: {
      //    bucket: process.env.S3_DOWNLOAD_BUCKET,
      //    publicKey: process.env.S3_DOWNLOAD_KEY,
      //    secretKey: process.env.S3_DOWNLOAD_SECRET,
      //  }
      //})

      server.ext('onPreResponse', (request, h) => {
        const response = request.response;

        if (response.isBoom) {
          response.output.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate, private, max-age=0'
          response.output.headers['Pragma'] = 'no-cache'
          response.output.headers['Expires'] = 0
        } else {
          response.header('Cache-Control', 'no-cache, no-store, must-revalidate, private, max-age=0');
          response.header('Pragma', 'no-cache');
          response.header('Expires', 0);
        }

        return h.continue;
      });

      //serv.listener.once('clientError', function (e) {
      //  console.error(e)
      //})

      // Routes
      server.route(
        [
          common.root
        ] //.concat(releaseRoutes, extensionRoutes, crashes, monitoring, androidRoutes, iosRoutes, braveCoreRoutes, promoProxy, installerEventsCollectionRoutes, webcompatRoutes)
      )

      await server.start((err) => {
        assert(!err, `error starting service ${err}`)
        console.log('update service started')
      })
    }

    init()
  })
})
