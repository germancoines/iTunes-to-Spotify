var dotenv = require('dotenv');
dotenv.config({ path: './config.env' });
var express = require('express');
var request = require('request');
var querystring = require('querystring');
var cookieParser = require('cookie-parser');
var multer = require('multer');
var storage = multer.memoryStorage();
var upload = multer({ storage: storage }).single('itunesXmlFile');
var bodyParser = require('body-parser');
var stateKey = 'spotify_auth_state';
var app = express();
var server = require('http').createServer(app);
var io = require('socket.io')(server);

const fs = require('fs');
const csvStringify = require('csv-stringify');

app.use(express.static(__dirname + '/public')).use(cookieParser());
app.use(bodyParser.json());

var XMLParser = require('./models/XMLParser');
var parser;

//var config = require('./config.js');
var client_id = process.env.client_id;
var client_secret = process.env.client_secret;
var redirect_uri = process.env.redirect_uri;
var refresh_token = '';
var access_token = '';

io.on('connection', function(client) {
  console.log(client.id);
});


app.get('/login', function(req, res) {
  var state = generateRandomString(16);
  res.cookie(stateKey, state);

  // your application requests authorization
  var scope = 'user-read-private user-read-email playlist-modify-public playlist-modify-private';
  res.redirect('https://accounts.spotify.com/authorize?' +
    querystring.stringify({
      response_type: 'code',
      client_id: client_id,
      scope: scope,
      redirect_uri: redirect_uri,
      state: state
    }));
});


app.get('/callback', function(req, res) {

  // your application requests refresh and access tokens
  // after checking the state parameter
  var code = req.query.code || null;
  var state = req.query.state || null;
  var storedState = req.cookies ? req.cookies[stateKey] : null;

  if (state === null || state !== storedState) {
    res.redirect('/#' +
      querystring.stringify({
        error: 'state_mismatch'
      }));
  } else {
    res.clearCookie(stateKey);
    var authOptions = {
      url: 'https://accounts.spotify.com/api/token',
      form: {
        code: code,
        redirect_uri: redirect_uri,
        grant_type: 'authorization_code'
      },
      headers: {
        'Authorization': 'Basic ' + (new Buffer.from(client_id + ':' + client_secret).toString('base64'))
      },
      json: true
    };

    request.post(authOptions, function(error, response, body) {
      if (!error && response.statusCode === 200) {

        access_token = body.access_token;
        refresh_token = body.refresh_token;

        var options = {
          url: 'https://api.spotify.com/v1/me',
          headers: { 'Authorization': 'Bearer ' + access_token },
          json: true
        };

        var userInfo = null;
        // use the access token to access the Spotify Web API
        request.get(options, function(error, response, body) {
          console.log(body);
          userInfo = body;
          res.redirect('/#' +
            querystring.stringify({
              user_id: userInfo.id,
              display_name: userInfo.display_name
            }));
        });

      } else {
        res.redirect('/#' +
          querystring.stringify({
            error: 'invalid_token'
          }));
      }
    });
  }
});


app.get('/refresh_token', function(req, res) {

  var authOptions = {
    url: 'https://accounts.spotify.com/api/token',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + (new Buffer.from(client_id + ':' + client_secret).toString('base64')) 
    },
    form: {
      grant_type: 'refresh_token',
      refresh_token: refresh_token
    },
    json: true
  };

  request.post(authOptions, function(error, response, body) {
    if (!error && response.statusCode === 200) {
      access_token = body.access_token;
      res.send({
        'access_token': access_token
      });
    }
  });
});


app.post('/upload', function(req, res) {
  upload(req, res, function(err) {
    if(err) {
      console.log('Error reading uploaded file');
      res.sendStatus(400);
    }

    io.to(req.body.socketid).emit('parseProgress', {status: 'Parsing file...', progress: 25});

    parser = new XMLParser();
    parser.parseBuffer(req.file.buffer, function(err) {
      if(err) {
        throw err;
      }

      io.to(req.body.socketid).emit('parseProgress', {status: 'Getting playlists...', progress: 50});
      
      parser.getPlaylists();
      io.to(req.body.socketid).emit('parseProgress', {status: 'Getting tracks...', progress: 70});

      parser.getTracks();
      io.to(req.body.socketid).emit('parseProgress', {status: 'Complete!', progress: 100});

      res.json(parser._playlists);
    });
  });
});


app.post('/:playlist/tracks', function(req, res) {
  var playlist = parser.getPlaylistByName(req.params.playlist);
  var tracks = [];

  if(playlist === undefined) {
    return res.sendStatus(404);
  }

  playlist._trackIds.forEach(function(id) {
    tracks.push(parser.getTrackById(id));
  });

  res.json(tracks);
});


app.post('/:playlist/export', function(req, res) {
  var playlist = parser.getPlaylistByName(req.params.playlist);
  var user = req.body.user;
  var tracks = [];

  // consts are empirical, documentation doesn't state
  // what the actual limits are...
  const chunkSize = 50;
  const wait = 20000;

  if(playlist === undefined) {
    return res.sendStatus(404);
  }

  // create playlist
  var authOptions = {
    url: 'https://api.spotify.com/v1/users/' + user + '/playlists',
    headers: { 'Authorization': 'Bearer ' + access_token },
    body: JSON.stringify({name: playlist._name, public: false}),
    json: true
  };

  request.post(authOptions, async function(error, response, body) {

    if (!error && response.statusCode == 201) {

      // playlist created OK, send status update
      io.to(req.body.socketid).emit('exportProgress', {playlist: playlist._name, status: 'Playlist created'});

      //now add the tracks
      var playlistId = body.id;
      var chunks = [];
      var x = 0;

      var cumTotal = 0;
      
      // split into chunks to avoid hitting API rate limit
      for(var i = 0; i < playlist._trackIds.length; i += chunkSize) {
        chunks.push(playlist._trackIds.slice(i, i + chunkSize));
      }

      chunks.forEach(function(chunk) {
        cumTotal += chunk.length;
      });

      console.log(cumTotal, ' should equal ', playlist._trackIds.length);

      var loopChunks = function(chunk) {
        console.log('chunk ', x + 1, ' request started');
        addTracksToPlaylist(chunks[x], user, playlistId, playlist._name, function(err, result) {
          if(err) {
            console.log('Error adding tracks: ', err, result);
            res.sendStatus(400);
          }

          // if we added any tracks, add them to the response
          if(result) {
            result.forEach(function(track) {
              tracks.push(track);
            });
          }

          // report progress
          io.to(req.body.socketid).emit('exportProgress', {playlist: playlist._name, status: x + 1 + ' / ' + chunks.length + ' chunks complete'});
          console.log('chunk ', x + 1, ' completed');

          x++;
          if(x < chunks.length) {
            // wait before sending the next request to avoid hitting rate limit
            setTimeout(function() {
              loopChunks(chunks);
            }, wait);
          } else {
            console.log('all chunks processed');
            io.to(req.body.socketid).emit('exportProgress', {playlist: playlist._name, status: 'Export complete'});
            res.status(201).send(tracks);
          }
        });
      };

      loopChunks(chunks);
    }
  });  
});


var nonExportedCsvData = [
  ['Artist', 'Album', 'Title', 'Error']
];

function addTracksToPlaylist(trackIds, user, playlistId, playlistName, callback) {
  var searchEndpoint = 'https://api.spotify.com/v1/search?q=';
  
  var tracksToAdd = [];

  // use promises so we can wait until all track search requests are complete
  // => allows us to access the calling object i.e. no need for var self = this;
  // we need to use .map because .forEach doesn't return anything and cannot support chaining
  var getTrackRequestPromises = trackIds.map((id) => {
    return new Promise((resolve, reject) => {
      var track = parser.getTrackById(id);
      var url = searchEndpoint + track.toString() + '&type=track&limit=1';

      var authOptionsAddTracks = {
        url: url,
        headers: { 'Authorization': 'Bearer ' + access_token },
      };

      request.get(authOptionsAddTracks, function(error, response, body) {
        if (!error && response.statusCode == 200) {
          try {
            var jsonResponse = JSON.parse(body);

            if(jsonResponse.hasOwnProperty('tracks')) {
              if(jsonResponse.tracks.items.length > 0) {
                track._spotifyUri = jsonResponse.tracks.items[0].uri;
                tracksToAdd.push(track._spotifyUri);
              } else {
                console.log('[NOT FOUND]: Track Id ' + track._id + ', Title ' + track._title);
                nonExportedCsvData.push([track._artist, track._album, track._title, false]);
                track._notFound = true;
              }
            }

          } catch {
            console.log('Error parsing response');
            track._error = true;
            nonExportedCsvData.push([track._artist, track._album, track._title, true]);
            // reject('Error parsing response: ' + e);
          }
        } else {
          console.log('Get Track Error: ', body);
          // reject('Get Track Error: ' + body);
          track._error = true;
        }

        resolve(track);
      });
    });
  });

  // when all track promises have completed add to the playlist
  Promise.all(getTrackRequestPromises).then(function(tracks) {
    if(tracksToAdd.length === 0) {
      // no tracks to add
      callback(null, null);
    } else {
      var playlistOptions = {
        url: 'https://api.spotify.com/v1/users/' + user + '/playlists/' + playlistId + '/tracks',
        headers: { 'Authorization': 'Bearer ' + access_token },
        body: JSON.stringify({ uris: tracksToAdd }),
        json: true
      };

      request.post(playlistOptions, function(error, response, body) {
        if(!error && response.statusCode == 201) {
          callback(null, tracks);
        } else {
          console.log('Add tracks to playlist error: ', body);
          callback('Add tracks to playlist error', null);
        }

        csvStringify.stringify(nonExportedCsvData, (err, output) => {
          if (err) {
              console.log('[ERROR] creating export results report');
              return;
          }
          
          fs.appendFileSync('C:\\Users\\germa\\' + playlistName + '.csv', output);
          nonExportedCsvData = [];
        });
      });
    }
  });
}


/**
 * Generates a random string containing numbers and letters
 * @param  {number} length The length of the string
 * @return {string} The generated string
 */
var generateRandomString = function(length) {
  var text = '';
  var possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

  for (var i = 0; i < length; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
};

//every 50 min request new access_token
setInterval(async function(){  
    await fetch("http://127.0.0.1:8888/refresh_token?refresh_token=" + refresh_token );
}, 3000000);

console.log('Listening on 8888');
// listen on Heroku's dynamically assigned port in production,
// or 8888 in development
server.listen(process.env.PORT);
