'use strict'
const log = require('lambda-log')
const Sharp = require('sharp')
const SrcBucket = process.env.srcBucket
const CacheBucket = process.env.cacheBucket
const CacheDomain = process.env.cacheDomain
const SrcPrefix = process.env.srcPrefix

const AWS = require('aws-sdk')
const S3 = new AWS.S3({
  signatureVersion: 'v4'
})

const path = require('path')

module.exports.handler = async (event) => {
  log.info('Event', { event, env: process.env })

  const albumId = event.pathParameters.albumId
  const photoId = event.pathParameters.photoId
  const filename = event.pathParameters.filename
  const transformations = event.pathParameters.transformations
  const imageName = event.pathParameters.imageName
  const cacheKey = decodeURIComponent(event.path).slice(1)

  log.info('Path', { transformations, photoId })

  const transf = parseTransformations(transformations)
  const resizeOptions = buildResizeOptions(transf)
  const format = getFormat(imageName)
  const srcKey = await getSrcKey(albumId, photoId, filename)

  const s3Params = {
    Bucket: SrcBucket,
    Key: srcKey
  }
  log.info('srcImage', { s3Params })
  return S3.getObject(s3Params).promise()
    .catch(err => {
      log.error('getObject', { s3Params, err })
      return {
        statusCode: 404
      }
    })
    .then(data => Sharp(data.Body)
      .rotate()
      .resize(resizeOptions)
      .toFormat(format)
      .toBuffer()
    )
    .then(buffer => {
      const s3Params = {
        Bucket: CacheBucket,
        ContentType: 'image/' + format,
        CacheControl: 'max-age=31536000',
        Key: cacheKey,
        StorageClass: 'STANDARD',
        ACL: 'public-read'
      }
      log.info('cacheImage', { s3Params })
      s3Params.Body = buffer
      return S3.putObject(s3Params).promise()
    })
    .then(res => {
      const response = {
        statusCode: 301,
        headers: {
          Location: `https://${CacheDomain}${event.path}`
        }
      }
      log.info('Response', { response })
      return response
    })
    .catch(err => {
      log.error('sharp', { err })
      return {
        statusCode: 500
      }
    })
}

const getFormat = filename => {
  let format = path.extname(filename).slice(1).toLowerCase()
  log.info('Format', { filename, format })
  if (format !== 'webp' && format !== 'png') {
    format = 'jpeg'
  }
  return format
}

const getSrcKey = async (albumId, photoId, filename) => {
  return [
    SrcPrefix,
    decodeURI(albumId),
    decodeURI(photoId),
    decodeURI(filename)
  ].join('/')
}

const parseTransformations = (transformations) => {
  const cropModes = {
    scale: Sharp.fit.fill,
    crop: Sharp.fit.cover,
    fit: Sharp.fit.inside,
    fill: Sharp.fit.cover,
    pad: Sharp.fit.contain,
    cover: Sharp.fit.outside
  }

  const els = transformations.split(',')
  const transf = {}
  els.forEach(el => {
    const [key, val] = decodeURIComponent(el.toLowerCase()).split('_')
    if (key === 'w' || key === 'h') {
      const val2 = parseInt(val)
      if (val2 > 0) {
        transf[key] = val2
      }
    }
    if (key === 'dpr') {
      const val2 = parseFloat(val)
      if (val2 > 0) {
        transf[key] = val2
      }
    }
    if (key === 'ar') {
      let val2
      if (val.includes(':')) {
        const [a, b] = val.split(':').map(Number)
        val2 = a / b
      } else {
        val2 = parseFloat(val)
      }
      if (val2 > 0) {
        transf[key] = val2
      }
    }
    if (key === 'c') {
      if (cropModes[val]) {
        transf[key] = cropModes[val]
      }
    }
    if (key === 'g') {
      if (['top', 'right top', 'right', 'right bottom', 'bottom', 'left bottom', 'left', 'left top', 'north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest', 'center', 'centre'].includes(val)) {
        transf[key] = val
      }
    }
    if (key === 'bg') {
      if (val.length === 6) {
        transf[key] = val
      }
    }
  })
  return transf
}

const buildResizeOptions = (transf) => {
  let height = null
  let width = null

  log.info('buildResizeOptions::before', { transf })

  const resizeOptions = {}
  if (transf.ar && transf.w && !transf.h) {
    height = Math.round(transf.w / transf.ar)
  }
  if (transf.ar && !transf.w && transf.h) {
    width = Math.round(transf.h * transf.ar)
  }
  if (width) {
    transf.w = width
  }
  if (height) {
    transf.h = height
  }
  if (transf.dpr) {
    if (transf.w) {
      transf.w = transf.w * transf.dpr
    }
    if (transf.h) {
      transf.h = transf.h * transf.dpr
    }
  }
  if (transf.w && transf.h && transf.c) {
    resizeOptions.fit = transf.c
  } else {
    delete transf.c
  }

  if (transf.w) {
    resizeOptions.width = Math.round(transf.w)
  }
  if (transf.h) {
    resizeOptions.height = Math.round(transf.h)
  }
  if (['cover', 'contain'].includes(transf.c) && transf.g) {
    resizeOptions.position = transf.g
  }
  if (transf.c === 'contain' && transf.bg) {
    resizeOptions.background = `#${transf.bg}`
  }
  resizeOptions.withoutEnlargement = true
  log.info('buildResizeOptions::after', { transf, resizeOptions })
  return resizeOptions
}
