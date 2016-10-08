var fs = require('fs'),
path = require('path'),
cache = require('memory-cache'),
crypto = require('crypto'),
im = require('imagemagick-stream'),
sizeOf = require('image-size'),
exif = require('./exif'),
URL = require('url'),
isPhoto = /(\.(jpg|bmp|jpeg|gif|png|tif))$/i,
_ = require('underscore'),
common,
config;

function getExInfo(photoFileSystemPath) {
  return new Promise(function(resolve, reject) {
    exif(photoFileSystemPath, function(exifErr, exifInfo){
      if (exifErr){
        console.log(exifErr)
        reject(exifErr);
      }
      var data = {
        name : path.basename(photoFileSystemPath), 
        exif : exifInfo
      };
      resolve(data);
    });
  })
}

module.exports = function(cfg){
  config = cfg;
  common = require('./common')(config);
  return function(req, res, next){
    
    // Retrieve the path, decoding %20s etc, replacing leading & trailing slash
    var pathFromReq = common.friendlyPath(req.path),
    staticFilesPath = './' + path.join(config.staticFiles, pathFromReq),
    data = _.clone(config);
    var albumPath = path.join(config.staticFiles, pathFromReq);

    var json = cache.get(albumPath);
    if (json) {
      // hit cache
    } else {
      // cache
      var jsonPath = path.join(albumPath, 'info.json');
      if (fs.existsSync(jsonPath)) {
        var json = fs.readFileSync(jsonPath, 'utf-8')
        json = JSON.parse(json)
        cache.put(albumPath, json);
      }
    }
    json = json || {}
    /*
     Request for an album thumbnail - TODO consider splitting out
     */
    if (req.query && req.query.tn){
      return _thumbnail(staticFilesPath, pathFromReq, function(err, thumb){
        if (err){
          return common.error(req, res, next, 404, 'No thumbnail found for this album', err);
        }

        var fstream = fs.createReadStream(path.join(thumb));
        var cachedResizedKey;
        var md5Name = crypto.createHash('md5').update(path.join(thumb)).digest('hex')
        cachedResizedKey = './tmp/' + md5Name + '.jpg';

        if (fs.existsSync(cachedResizedKey)){
          // cache hit - read & return
          var cacheReadStream = fs.createReadStream(cachedResizedKey);
          cacheReadStream.on('error', function(){
            return common.error(req, res, next, 404, 'File not found', err);
          });
          return cacheReadStream.pipe(res);  
        }
        return 'resizestream.pipe(res)';       

      });
    }
    /*
      Determined we're not requesting the thumbnail file - render the album page
     */
    fs.readdir(staticFilesPath, function (err, files) { 
      if (err){
        return common.error(req, res, next, 404, 'No album found', err);
      }
      
      data.isRoot = (req.path === '/' || req.path === '');
      data.breadcrumb = common.breadcrumb(pathFromReq),
      data.name = json.name || _.last(data.breadcrumb).name || config.title;
      json.password && (data.password = json.password);

      data.albums = _getAlbums(files, staticFilesPath, pathFromReq, json);

      var arg = URL.parse(req.url, true).query;
      var reqPw = arg.password;
      if (json.password && (json.password !== reqPw)) {
        req.data = {
          title: config.title
        }
        req.tpl = 'empty.ejs';
        return next();
      }
      _getPhotos(files, staticFilesPath, pathFromReq, function(photoData) {
        data.photos = photoData;
        req.data = data;
        req.tpl = 'album.ejs';
        return next();
      });
    });
  }
}

function _getAlbums(files, staticFilesPath, pathFromReq, json){
  files = _.filter(files, function(file){
    var stat = fs.statSync(path.join(staticFilesPath, file));
    return stat.isDirectory()
  });
  
  files = _.map(files, function(albumName){
    var albumPath = path.join(staticFilesPath, pathFromReq, albumName);
    var password = cache.get(albumPath)
    var json = cache.get(albumPath) || {}
    return {
      url : path.join(config.urlRoot, pathFromReq, albumName),
      name : albumName,
      password: json.password
    };
  });
  return files;
}

function formatName (time) {
  return parseInt(time.replace(/(:|\s)+/g, ''));
}

function sortByName (files) {
  for (var i = 0, len = files.length; i < len; i++) {
    for (var j = i + 1; j < len; j++) {
      if (formatName(files[i].exif.Time) > formatName(files[j].exif.Time)) {
        var temp = files[i];
        files[i] = files[j];
        files[j] = temp;
      }
    }
  }
  return files;
}
function _getPhotos(files, staticFilesPath, pathFromReq, cb){
  files = _.filter(files, function(file){
    var stat = fs.statSync(path.join(staticFilesPath, file));
    return file.match(isPhoto) && !stat.isDirectory()
  });

  var promiseArr = []
  var exifMap = {}
  files.forEach(function(photoFileName) {
    promiseArr.push(
      getExInfo(path.join(staticFilesPath, photoFileName))
      .then(function(data) {
        exifMap[photoFileName] = data.exif
      })
    );
  })
  Promise.all(promiseArr).then(function() {
    files = _.map(files, function(photoFileName){
      var photoName = photoFileName.replace(isPhoto, '');
      var dimensions = sizeOf(path.join(staticFilesPath, photoFileName));
      return {
        url : path.join(config.urlRoot, pathFromReq, 'photo', photoName),
        src : path.join(config.urlRoot, pathFromReq, photoFileName),
        path : path.join(pathFromReq, photoFileName),
        size: dimensions.width + 'x' + dimensions.height,
        name : photoName,
        exif: exifMap[photoFileName] || null
      };
    });
    cb(sortByName(files))
  });
}

function _thumbnail(albumPath, pathFromRequest, cb){
  var cached = cache.get(albumPath);
  //console.log(cached)
  if (cached){
    return cb(null, cached);
  }

  // TODO - This is a bit messy - reduce number of params we need to pass
  fs.readdir(albumPath, function (err, files) {
    _getPhotos(files, albumPath, pathFromRequest, function(photoData) {
      var photos = photoData;
      albums = _getAlbums(files, albumPath, pathFromRequest);
      if (photos.length > 0){
        /*fs.readFile(path.join(config.staticFiles, pathFromRequest, 'info.json'), 'utf-8', function(err, data) {
          // We have a photo, let's return the first as the thumb
          var firstPhoto = _.first(photos).path;
          firstPhoto = path.join(config.staticFiles, firstPhoto);
          if (data && data.thumbnail) {
            data = JSON.parse(data)
            console.log(data);
            firstPhoto = path.join(config.staticFiles, pathFromRequest, data.thumbnail)
          }
          //console.log(firstPhoto);
          //cache.put(albumPath, firstPhoto);
          return cb(null, firstPhoto)
        })*/
        var firstPhoto
        albumPath = path.join(albumPath, '')
        var data = cache.get(albumPath)
        if (data && data.thumbnail) {
          firstPhoto = path.join(config.staticFiles, pathFromRequest, data.thumbnail)
        } else {
          var firstPhoto = _.first(photos).path
          firstPhoto = path.join(config.staticFiles, firstPhoto)
        }
        return cb(null, firstPhoto)
      }else if (albums.length > 0){
        // No photos found - iterate thru the albums and find a suitable child to return
        // TODO: If this first sub-album is empty this will fail. Is this OK?
        var firstAlbum = _.first(albums).name;
        return _thumbnail(path.join(albumPath, firstAlbum), path.join(pathFromRequest, firstAlbum), cb);
      }else{
        // None exist
        return cb('No suitable thumbnail found');  
      }
    })
  });
}
