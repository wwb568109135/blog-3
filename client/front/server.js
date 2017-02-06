const isProd = process.env.NODE_ENV === 'production'

const log = require('log4js').getLogger('ssr server')
const fs = require('fs')
const path = require('path')
const resolve = file => path.resolve(__dirname, file)
const express = require('express')
const favicon = require('serve-favicon')
const schedule = require('node-schedule')
const createBundleRenderer = require('vue-server-renderer').createBundleRenderer
const request = require('axios')
const uuid = require('uuid')

const sendGoogleAnalytic = require('./middleware/serverGoogleAnalytic')
const getRobotsFromConfig = require('./server/robots.js')
const { api: sitemapApi, getSitemapFromBody } = require('./server/sitemap.js')
const { api: rssApi, getRssBodyFromBody } = require('./server/rss.js')
const inline = isProd ? fs.readFileSync(resolve('./dist/styles.css'), 'utf-8') : ''
const config = require('./server/config')
const titleReg = /<.*?>(.+?)<.*?>/
const expires = 3600 * 1000 * 24 * 365 * 2

let sitemap = ''
let rss = ''
let robots = ''

config.flushOption().then(() => {
  robots = getRobotsFromConfig(config)

  const flushSitemap = () => request.get(sitemapApi).then(result => {
    sitemap = getSitemapFromBody(result, config)
  })

  const flushRss = () => request.get(rssApi).then(result => {
    rss = getRssBodyFromBody(result, config)
  })

  flushSitemap()
  flushRss()
  schedule.scheduleJob('30 3 * * * ', function () {
    flushRss()
    flushSitemap()
  })

  let app = express()
  app.enable('trust proxy')
  let renderer
  let html // generated by html-webpack-plugin
  if (isProd) {
    const bundlePath = resolve('./dist/server-bundle.js')
    renderer = createRenderer(fs.readFileSync(bundlePath, 'utf-8'))
    html = flushHtml(fs.readFileSync(resolve('./dist/index.html'), 'utf-8'))
  } else {
    // in development: setup the dev server with watch and hot-reload,
    // and update renderer / index HTML on file change.
    require('./build/setup-dev-server')(app, {
      bundleUpdated: bundle => {
        renderer = createRenderer(bundle)
      },
      indexUpdated: index => {
        html = flushHtml(index)
      }
    })
  }

  function flushHtml (template) {
    const style = isProd ? `<style type="text/css">${inline}</style>` : ''
    const i = template.indexOf('<div id=app></div>')
    return {
      head: template.slice(0, i).replace('<link href="/dist/styles.css" rel="stylesheet">', style),
      tail: template.slice(i + '<div id=app></div>'.length)
    }
  }

  function createRenderer (bundle) {
    return createBundleRenderer(bundle, {
      cache: require('lru-cache')({
        max: 1000,
        maxAge: 1000 * 60 * 15
      })
    })
  }

  app.use(require('cookie-parser')())
  app.use(favicon(config.favicon))
  app.use((req, res, next) => {
    log.debug(`${req.method} ${decodeURIComponent(req.url)}`)
    return next()
  })
  const serve = (path, cache) => express.static(resolve(path), {
    maxAge: cache && isProd ? 60 * 60 * 24 * 30 : 0,
    fallthrough: false
  })
  app.use('/service-worker.js', serve('./dist/service-worker.js'))
  app.use('/dist', serve('./dist'))
  app.use('/static', serve('./static'))
  app.get('/favicon.ico', (req, res) => res.status(404).end())
  app.get('/_.gif', (req, res, next) => sendGoogleAnalytic(req, res, next))
  app.get('/robots.txt', (req, res, next) => res.end(robots))
  app.get('/rss.xml', (req, res, next) => {
    res.header('Content-Type', 'application/xml')
    return res.end(rss)
  })
  app.get('/sitemap.xml', (req, res, next) => {
    res.header('Content-Type', 'application/xml')
    return res.end(sitemap)
  })

  app.get('*', (req, res, next) => {
    if (!renderer) {
      return res.end('waiting for compilation... refresh in a moment.')
    }

    let s = Date.now()
    const context = {
      url: req.url
    }
    const renderStream = renderer.renderToStream(context)

    res.header('Content-Type', 'text/html; charset=utf-8')

    renderStream.once('data', () => {
      const { title, link, meta } = context.meta.inject()
      const titleText = title.text()
      const metaData = `${titleText}${meta.text()}${link.text()}`
      const matched = titleText.match(titleReg)
      let clientId = req.cookies.id
      if (!clientId) {
        clientId = uuid.v4()
        res.cookie('id', clientId, {
          expires: new Date(Date.now() + expires)
        })
      }
      const chunk = html.head.replace('<title></title>', metaData)
      res.write(chunk)
      sendGoogleAnalytic(req, res, next, {
        dt: matched ? matched[1] : config.title,
        dr: req.url,
        dp: req.url,
        z: +Date.now(),
        cid: clientId
      })
    })

    renderStream.on('data', chunk => {
      res.write(chunk)
    })

    renderStream.on('end', () => {
      if (context.initialState) {
        res.write(
          `<script>window.__INITIAL_STATE__=${
          JSON.stringify(context.initialState)
          }</script>`
        )
      }
      res.end(html.tail)
      log.debug(`whole request: ${Date.now() - s}ms`)
    })

    renderStream.on('error', err => {
      res.end(html.tail)
      log.error(err)
    })
  })

  const port = process.env.PORT || 8080
  app.listen(port, () => {
    log.debug(`server started at localhost:${port}`)
  })
}).catch(err => log.error(err))

