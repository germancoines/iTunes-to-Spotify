// private members
var fs = require('fs');
var xml2js = require('xml2js');
var path = require('path');
var Playlist = require('./Playlist');
var Track = require('./Track');

// Constructor
function XMLParser() {
	this._parsedXml = null;
	this._playlists = [];
	this._tracks = [];
}

// Methods
XMLParser.prototype.parse = function(filename, callback) {
	var parser = new xml2js.Parser();
	var self = this;

	fs.readFile(path.join(__dirname, '../data/', filename), function(err, data) {
		if(err) {
			var err = new Error('Could not find document');
	      	return callback(err);
	    }

	    parser.parseString(data, function(err, result) {
	      if(err) {
	      	var err = new Error('Failed to parse XML');
	      	return callback(err);
	      }
	      
	      self._parsedXml = result;
	      return callback(null);
	    });
	});
}

XMLParser.prototype.parseBuffer = function(buffer, callback) {
	var parser = new xml2js.Parser();
	var self = this;

    parser.parseString(buffer, function(err, result) {
      if(err) {
      	var err = new Error('Failed to parse XML');
      	return callback(err);
      }
      
      self._parsedXml = result;
      return callback(null);
    });
}

XMLParser.prototype.getPlaylists = function() {
	var playlists = this._parsedXml.plist.dict[0].array[0].dict;

	for(var i = 0; i < playlists.length; i++) {

		// push new playlist to collection
		var newPlaylist = new Playlist(playlists[i].string[0]);

		// get track ids belonging to playlist
		if(typeof playlists[i].array !== 'undefined') {
		  var playlistTracksArray = playlists[i].array[0].dict;

		  for(var j = 0; j < playlistTracksArray.length; j++) {
		    newPlaylist.addTrackId(playlistTracksArray[j].integer[0]);
		  }
		}

		this._playlists.push(newPlaylist);
	}
}

XMLParser.prototype.getTracks = function() {
	var tracks = this._parsedXml.plist.dict[0].dict[0].dict;

	// get keys and construct an array
	var tracksKeys = Object.keys(tracks).map(function(key) {
    	return tracks[key];
  	});

	for(var i = 0; i < tracks.length; i++) {

		// The album index can vary depending on the presence of other meta-data
		// Id, Name, Artist are always in order, so we can index them manually,
		// for the album, we search the keys for the 'Album' information
		// we subtract 1 to account for the id which is in the integer collection
		var albumIndex = tracksKeys[i].key.indexOf('Album') - 1;
		var album;

		if(albumIndex < 0) {
			// no album information found
			album = null;
		} else {
			album = tracks[i].string[albumIndex];
		}

		var newTrack = new Track(tracks[i].integer[0],	// Id
								tracks[i].string[0],	// Name
								tracks[i].string[1],	// Artist
								album);					// Album

		this._tracks.push(newTrack);
	}
}

XMLParser.prototype.getTrackById = function(id) {

	// remember to return from the correct function
	// returning from the anonymous function only returns to
	// getTrackById() which then needs to return to its caller
	return this._tracks.find(function(track) {
		return track._id === id;
	});
}

XMLParser.prototype.getPlaylistByName = function(name) {
	return this._playlists.find(function(playlist) {
		return playlist._name === name;
	});
}

module.exports = XMLParser;