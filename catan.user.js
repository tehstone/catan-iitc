// ==UserScript==
// @id           catan-iitc@tehstone
// @name         Catan Tools
// @category     Layer
// @version      0.2.0
// @namespace    https://github.com/tehstone/catan-iitc
// @downloadURL  https://github.com/tehstone/catan-iitc/raw/master/catan.user.js
// @homepageURL  https://github.com/tehstone/catan-iitc
// @description  Catan World Explorers tools over IITC
// @author       tehstone
// @match        https://www.ingress.com/intel*
// @match        https://ingress.com/intel*
// @match        https://intel.ingress.com/*
// @grant        none
// ==/UserScript==

/* eslint-env es6 */
/* eslint no-var: "error" */
/* globals L, S2, map */
/* globals GM_info, $, dialog */
/* globals renderPortalDetails, findPortalGuidByPositionE6 */

/** S2 Geometry functions

 S2 extracted from Regions Plugin
 https:static.iitc.me/build/release/plugins/regions.user.js

 the regional scoreboard is based on a level 6 S2 Cell
 - https:docs.google.com/presentation/d/1Hl4KapfAENAOf4gv-pSngKwvS_jwNVHRPZTTDzXXn6Q/view?pli=1#slide=id.i22
 at the time of writing there's no actual API for the intel map to retrieve scoreboard data,
 but it's still useful to plot the score cells on the intel map


 the S2 geometry is based on projecting the earth sphere onto a cube, with some scaling of face coordinates to
 keep things close to approximate equal area for adjacent cells
 to convert a lat,lng into a cell id:
 - convert lat,lng to x,y,z
 - convert x,y,z into face,u,v
 - u,v scaled to s,t with quadratic formula
 - s,t converted to integer i,j offsets
 - i,j converted to a position along a Hubbert space-filling curve
 - combine face,position to get the cell id

 NOTE: compared to the google S2 geometry library, we vary from their code in the following ways
 - cell IDs: they combine face and the hilbert curve position into a single 64 bit number. this gives efficient space
             and speed. javascript doesn't have appropriate data types, and speed is not cricical, so we use
             as [face,[bitpair,bitpair,...]] instead
 - i,j: they always use 30 bits, adjusting as needed. we use 0 to (1<<level)-1 instead
        (so GetSizeIJ for a cell is always 1)
*/

;function wrapperS2() { // eslint-disable-line no-extra-semi

  const S2 = window.S2 = {};

  function LatLngToXYZ(latLng) {
    const d2r = Math.PI / 180.0;
    const phi = latLng.lat * d2r;
    const theta = latLng.lng * d2r;
    const cosphi = Math.cos(phi);

    return [Math.cos(theta) * cosphi, Math.sin(theta) * cosphi, Math.sin(phi)];
  }

  function XYZToLatLng(xyz) {
    const r2d = 180.0 / Math.PI;

    const lat = Math.atan2(xyz[2], Math.sqrt(xyz[0] * xyz[0] + xyz[1] * xyz[1]));
    const lng = Math.atan2(xyz[1], xyz[0]);

    return {lat: lat * r2d, lng: lng * r2d};
  }

  function largestAbsComponent(xyz) {
    const temp = [Math.abs(xyz[0]), Math.abs(xyz[1]), Math.abs(xyz[2])];

    if (temp[0] > temp[1]) {
      if (temp[0] > temp[2]) {
        return 0;
      }
      return 2;
    }

    if (temp[1] > temp[2]) {
      return 1;
    }

    return 2;
  }

  function faceXYZToUV(face,xyz) {
    let u, v;

    switch (face) {
      case 0: u =  xyz[1] / xyz[0]; v =  xyz[2] / xyz[0]; break;
      case 1: u = -xyz[0] / xyz[1]; v =  xyz[2] / xyz[1]; break;
      case 2: u = -xyz[0] / xyz[2]; v = -xyz[1] / xyz[2]; break;
      case 3: u =  xyz[2] / xyz[0]; v =  xyz[1] / xyz[0]; break;
      case 4: u =  xyz[2] / xyz[1]; v = -xyz[0] / xyz[1]; break;
      case 5: u = -xyz[1] / xyz[2]; v = -xyz[0] / xyz[2]; break;
      default: throw {error: 'Invalid face'};
    }

    return [u,v];
  }

  function XYZToFaceUV(xyz) {
    let face = largestAbsComponent(xyz);

    if (xyz[face] < 0) {
      face += 3;
    }

    const uv = faceXYZToUV(face, xyz);

    return [face, uv];
  }

  function FaceUVToXYZ(face, uv) {
    const u = uv[0];
    const v = uv[1];

    switch (face) {
      case 0: return [1, u, v];
      case 1: return [-u, 1, v];
      case 2: return [-u,-v, 1];
      case 3: return [-1,-v,-u];
      case 4: return [v,-1,-u];
      case 5: return [v, u,-1];
      default: throw {error: 'Invalid face'};
    }
  }

  function STToUV(st) {
    const singleSTtoUV = function (st) {
      if (st >= 0.5) {
        return (1 / 3.0) * (4 * st * st - 1);
      }
      return (1 / 3.0) * (1 - (4 * (1 - st) * (1 - st)));

    };

    return [singleSTtoUV(st[0]), singleSTtoUV(st[1])];
  }

  function UVToST(uv) {
    const singleUVtoST = function (uv) {
      if (uv >= 0) {
        return 0.5 * Math.sqrt (1 + 3 * uv);
      }
      return 1 - 0.5 * Math.sqrt (1 - 3 * uv);

    };

    return [singleUVtoST(uv[0]), singleUVtoST(uv[1])];
  }

  function STToIJ(st,order) {
    const maxSize = 1 << order;

    const singleSTtoIJ = function (st) {
      const ij = Math.floor(st * maxSize);
      return Math.max(0, Math.min(maxSize - 1, ij));
    };

    return [singleSTtoIJ(st[0]), singleSTtoIJ(st[1])];
  }

  function IJToST(ij,order,offsets) {
    const maxSize = 1 << order;

    return [
      (ij[0] + offsets[0]) / maxSize,
      (ij[1] + offsets[1]) / maxSize
    ];
  }

  // S2Cell class
  S2.S2Cell = function () {};

  //static method to construct
  S2.S2Cell.FromLatLng = function (latLng, level) {
    const xyz = LatLngToXYZ(latLng);
    const faceuv = XYZToFaceUV(xyz);
    const st = UVToST(faceuv[1]);
    const ij = STToIJ(st,level);

    return S2.S2Cell.FromFaceIJ(faceuv[0], ij, level);
  };

  S2.S2Cell.FromFaceIJ = function (face, ij, level) {
    const cell = new S2.S2Cell();
    cell.face = face;
    cell.ij = ij;
    cell.level = level;

    return cell;
  };

  S2.S2Cell.prototype.toString = function () {
    return 'F' + this.face + 'ij[' + this.ij[0] + ',' + this.ij[1] + ']@' + this.level;
  };

  S2.S2Cell.prototype.getLatLng = function () {
    const st = IJToST(this.ij, this.level, [0.5, 0.5]);
    const uv = STToUV(st);
    const xyz = FaceUVToXYZ(this.face, uv);

    return XYZToLatLng(xyz);
  };

  S2.S2Cell.prototype.getCornerLatLngs = function () {
    const offsets = [
      [0.0, 0.0],
      [0.0, 1.0],
      [1.0, 1.0],
      [1.0, 0.0]
    ];

    return offsets.map(offset => {
      const st = IJToST(this.ij, this.level, offset);
      const uv = STToUV(st);
      const xyz = FaceUVToXYZ(this.face, uv);

      return XYZToLatLng(xyz);
    });
  };

  S2.S2Cell.prototype.getNeighbors = function (deltas) {

    const fromFaceIJWrap = function (face,ij,level) {
      const maxSize = 1 << level;
      if (ij[0] >= 0 && ij[1] >= 0 && ij[0] < maxSize && ij[1] < maxSize) {
        // no wrapping out of bounds
        return S2.S2Cell.FromFaceIJ(face,ij,level);
      }

      // the new i,j are out of range.
      // with the assumption that they're only a little past the borders we can just take the points as
      // just beyond the cube face, project to XYZ, then re-create FaceUV from the XYZ vector
      let st = IJToST(ij,level,[0.5, 0.5]);
      let uv = STToUV(st);
      let xyz = FaceUVToXYZ(face, uv);
      const faceuv = XYZToFaceUV(xyz);
      face = faceuv[0];
      uv = faceuv[1];
      st = UVToST(uv);
      ij = STToIJ(st,level);
      return S2.S2Cell.FromFaceIJ(face, ij, level);
    };

    const face = this.face;
    const i = this.ij[0];
    const j = this.ij[1];
    const level = this.level;

    if (!deltas) {
      deltas = [
        {a: -1, b: 0},
        {a: 0, b: -1},
        {a: 1, b: 0},
        {a: 0, b: 1}
      ];
    }
    return deltas.map(function (values) {
      return fromFaceIJWrap(face, [i + values.a, j + values.b], level);
    });
  };
}

/** Our code
* For safety, S2 must be initialized before our code
*
* Code is modified from the Pokemon GO plugin
* https://gitlab.com/AlfonsoML/pogo-s2/raw/master/s2check.user.js
*/
function wrapperPlugin(plugin_info) {
  'use strict';

  // based on https://github.com/iatkin/leaflet-svgicon
  function initSvgIcon() {
    L.DivIcon.SVGIcon = L.DivIcon.extend({
      options: {
        'className': 'svg-icon',
        'iconAnchor': null, //defaults to [iconSize.x/2, iconSize.y] (point tip)
        'iconSize': L.point(48, 48)
      },
      initialize: function (options) {
        options = L.Util.setOptions(this, options);

        //iconSize needs to be converted to a Point object if it is not passed as one
        options.iconSize = L.point(options.iconSize);

        if (!options.iconAnchor) {
          options.iconAnchor = L.point(Number(options.iconSize.x) / 2, Number(options.iconSize.y));
        } else {
          options.iconAnchor = L.point(options.iconAnchor);
        }
      },

      // https://github.com/tonekk/Leaflet-Extended-Div-Icon/blob/master/extended.divicon.js#L13
      createIcon: function (oldIcon) {
        let div = L.DivIcon.prototype.createIcon.call(this, oldIcon);

        if (this.options.id) {
          div.id = this.options.id;
        }

        if (this.options.style) {
          for (let key in this.options.style) {
            div.style[key] = this.options.style[key];
          }
        }
        return div;
      }
    });

    L.divIcon.svgIcon = function (options) {
      return new L.DivIcon.SVGIcon(options);
    };

    L.Marker.SVGMarker = L.Marker.extend({
      options: {
        'iconFactory': L.divIcon.svgIcon,
        'iconOptions': {}
      },
      initialize: function (latlng, options) {
        options = L.Util.setOptions(this, options);
        options.icon = options.iconFactory(options.iconOptions);
        this._latlng = latlng;
      },
      onAdd: function (map) {
        L.Marker.prototype.onAdd.call(this, map);
      }
    });

    L.marker.svgMarker = function (latlng, options) {
      return new L.Marker.SVGMarker(latlng, options);
    };
  }

  /**
   * Saves a file to disk with the provided text
   * @param {string} text - The text to save
   * @param {string} filename - Proposed filename
   */
  function saveToFile(text, filename) {
    if (typeof text != 'string') {
      text = JSON.stringify(text);
    }

    if (typeof window.android !== 'undefined' && window.android.saveFile) {
      window.android.saveFile(filename, 'application/json', text);
      return;
    }

    if (isIITCm()) {
      promptForCopy(text);
      return;
    }

    // http://stackoverflow.com/a/18197341/250294
    const element = document.createElement('a');

    // http://stackoverflow.com/questions/13405129/javascript-create-and-save-file
    const file = new Blob([text], {type: 'text/plain'});
    element.setAttribute('href', URL.createObjectURL(file));

    element.setAttribute('download', filename);

    element.style.display = 'none';
    document.body.appendChild(element);

    element.click();

    document.body.removeChild(element);
  }

  /**
   * Prompts the user to select a file and then reads its contents and calls the callback function with those contents
   * @param {Function} callback - Function that will be called when the file is read.
   * Callback signature: function( {string} contents ) {}
   */
  function readFromFile(callback) {
    // special hook from iitcm
    if (typeof window.requestFile != 'undefined') {
      window.requestFile(function (filename, content) {
        callback(content);
      });
      return;
    }

    if (isIITCm()) {
      promptForPaste(callback);
      return;
    }

    const input = document.createElement('input');
    input.type = 'file';
    input.className = 'baseutils-filepicker';
    document.body.appendChild(input);

    input.addEventListener('change', function () {
      const reader = new FileReader();
      reader.onload = function () {
        callback(reader.result);
      };
      reader.readAsText(input.files[0]);
      document.body.removeChild(input);
    }, false);

    input.click();
  }

  function promptForPaste(callback) {
    const div = document.createElement('div');

    const textarea = document.createElement('textarea');
    textarea.style.width = '100%';
    textarea.style.minHeight = '8em';
    div.appendChild(textarea);

    const container = dialog({
      id: 'promptForPaste',
      html: div,
      width: '360px',
      title: 'Paste here the data',
      buttons: {
        OK: function () {
          container.dialog('close');
          callback(textarea.value);
        }
      }
    });
  }

  function promptForCopy(text) {
    const div = document.createElement('div');

    const textarea = document.createElement('textarea');
    textarea.style.width = '100%';
    textarea.style.minHeight = '8em';
    textarea.value = text;
    div.appendChild(textarea);

    const container = dialog({
      id: 'promptForCopy',
      html: div,
      width: '360px',
      title: 'Copy this data',
      buttons: {
        OK: function () {
          container.dialog('close');
        }
      }
    });
  }

  const TIMERS = {};
  function createThrottledTimer(name, callback, ms) {
    if (TIMERS[name])
      clearTimeout(TIMERS[name]);

    // throttle if there are several calls to the functions
    TIMERS[name] = setTimeout(function() {
      delete TIMERS[name];
      if (typeof window.requestIdleCallback == 'undefined')
        callback();
      else
        // and even now, wait for iddle
        requestIdleCallback(function() {
          callback();
        }, { timeout: 2000 });

    }, ms || 100);
  }

  /**
   * Try to identify if the browser is IITCm due to special bugs like file picker not working
   */
  function isIITCm() {
    const ua = navigator.userAgent;
    if (!ua.match(/Android.*Mobile/))
      return false;

    if (ua.match(/; wb\)/))
      return true;

    return ua.match(/ Version\//);
  }

  let resources = {};
  let settlements = {};
  // Portals that aren't marked as Catan items
  let notcatan = {};

  let allPortals = {};
  let newPortals = {};
  let checkNewPortalsTimout;

  // Portals that the user hasn't classified (2 or more in the same Lvl17 cell)
  let skippedPortals = {};
  // let newPokestops = {};
  let notClassifiedPois = [];

  // Portals that we know, but that have been moved from our stored location.
  let movedPortals = [];

  // Catan items that are no longer available.
  let missingPortals = {};

  // Leaflet layers
  let regionLayer; // s2 grid
  let resourceLayerGroup; // resources
  let settlementLayerGroup; // settelements
  let notCatanLayerGroup; // not in Catan (N/A)
  let nearbyGroupLayer; // circles to mark the too near limit

  // Group of items added to the layer
  let resourceLayers = {};
  let settlementLayers = {};
  let notCatanLayers = {};
  let nearbyCircles = {};

  const defaultSettings = {
    thisIsCatan: false,
    analyzeForMissingData: true,
    grids: [
      {
        level: 14,
        width: 5,
        color: '#004D40',
        opacity: 0.5
      },
      {
        level: 0,
        width: 2,
        color: '#388E3C',
        opacity: 0.5
      }
    ],
    colors: {
      cell17Filled: {
        color: '#000000',
        opacity: 0.6
      },
      cell14Filled: {
        color: '#000000',
        opacity: 0.5
      },
      nearbyCircleBorder: {
        color: '#000000',
        opacity: 0.6
      },
      nearbyCircleFill: {
        color: '#000000',
        opacity: 0.4
      },
    },
    saveDataType: 'Settlements',
    saveDataFormat: 'CSV'
  };

  let settings = defaultSettings;

  function saveSettings() {
    createThrottledTimer('saveSettings', function() {
      localStorage['catan_settings'] = JSON.stringify(settings);
    });
  }

  function loadSettings() {
    const tmp = localStorage['catan_settings'] || localStorage['s2check_settings'];
    if (!tmp)
      return;
    try  {
      settings = JSON.parse(tmp);
    } catch (e) { // eslint-disable-line no-empty
    }
    if (typeof settings.analyzeForMissingData == 'undefined') {
      settings.analyzeForMissingData = true;
    }
    if (typeof settings.promptForMissingData != 'undefined') {
      delete settings.promptForMissingData;
    }
    if (!settings.colors) {
      resetColors();
    }
    if (typeof settings.saveDataType == 'undefined') {
      settings.saveDataType = 'Settlements';
    }
    if (typeof settings.saveDataFormat == 'undefined') {
      settings.saveDataFormat = 'CSV';
    }

    setThisIsCatan();
  }

  function resetColors() {
    settings.grids[0].color = defaultSettings.grids[0].color;
    settings.grids[0].opacity = defaultSettings.grids[0].opacity;
    settings.grids[1].color = defaultSettings.grids[1].color;
    settings.grids[1].opacity = defaultSettings.grids[1].opacity;
    settings.colors = defaultSettings.colors;
  }

  let originalHighlightPortal;

  function setThisIsCatan() {
    document.body.classList[settings.thisIsCatan ? 'add' : 'remove']('thisIsCatan');

    if (settings.thisIsCatan) {
      removeIngressLayers();
      if (window._current_highlighter == window._no_highlighter) {
        // extracted from IITC plugin: Hide portal ownership

        originalHighlightPortal = window.highlightPortal;
        window.highlightPortal = portal => {
          window.portalMarkerScale();
          const hidePortalOwnershipStyles = window.getMarkerStyleOptions({team: window.TEAM_NONE, level: 0});
          portal.setStyle(hidePortalOwnershipStyles);
        };
        window.resetHighlightedPortals();
      }
    } else {
      restoreIngressLayers();
      if (originalHighlightPortal != null) {
        window.highlightPortal = originalHighlightPortal;
        originalHighlightPortal = null;
        window.resetHighlightedPortals();
      }
    }
  }

  function sortByName(a, b) {
    if (!a.name)
      return -1;

    return a.name.localeCompare(b.name);
  }

  function isCellOnScreen(mapBounds, cell) {
    const corners = cell.getCornerLatLngs();
    const cellBounds = L.latLngBounds([corners[0],corners[1]]).extend(corners[2]).extend(corners[3]);
    return cellBounds.intersects(mapBounds);
  }

  // return only the cells that are visible by the map bounds to ignore far away data that might not be complete
  function filterWithinScreen(cells) {
    const bounds = map.getBounds();
    const filtered = {};
    Object.keys(cells).forEach(cellId => {
      const cellData = cells[cellId];
      const cell = cellData.cell;

      if (isCellInsideScreen(bounds, cell)) {
        filtered[cellId] = cellData;
      }
    });
    return filtered;
  }

  function isCellInsideScreen(mapBounds, cell) {
    const corners = cell.getCornerLatLngs();
    const cellBounds = L.latLngBounds([corners[0],corners[1]]).extend(corners[2]).extend(corners[3]);
    return mapBounds.contains(cellBounds);
  }

  /**
  * Filter a group of items (resources/settlements) excluding those out of the screen
  */
  function filterItemsByMapBounds(items) {
    const bounds = map.getBounds();
    const filtered = {};
    Object.keys(items).forEach(id => {
      const item = items[id];

      if (isPointOnScreen(bounds, item)) {
        filtered[id] = item;
      }
    });
    return filtered;
  }

  function isPointOnScreen(mapBounds, point) {
    if (point._latlng)
      return mapBounds.contains(point._latlng);

    return mapBounds.contains(L.latLng(point));
  }

  function groupByCell(level) {
    const cells = {};
    classifyGroup(cells, resources, level, (cell, item) => cell.resources.push(item));
    classifyGroup(cells, settlements, level, (cell, item) => cell.settlements.push(item));
    classifyGroup(cells, newPortals, level, (cell, item) => cell.notClassified.push(item));
    classifyGroup(cells, notcatan, level, (cell, item) => cell.notCatan.push(item));

    return cells;
  }

  function classifyGroup(cells, items, level, callback) {
    Object.keys(items).forEach(id => {
      const item = items[id];
      if (!item.cells) {
        item.cells = {};
      }
      let cell;
      // Compute the cell only once for each level
      if (!item.cells[level]) {
        cell = window.S2.S2Cell.FromLatLng(item, level);
        item.cells[level] = cell.toString();
      }
      const cellId = item.cells[level];

      // Add it to the array of POIs of that cell
      if (!cells[cellId]) {
        if (!cell) {
          cell = window.S2.S2Cell.FromLatLng(item, level);
        }
        cells[cellId] = {
          cell: cell,
          resources: [],
          settlements: [],
          notClassified: [],
          notCatan: []
        };
      }
      callback(cells[cellId], item);
    });
  }

  /**
   * Returns the items that belong to the specified cell
   */
  function findCellItems(cellId, level, items) {
    return Object.values(items).filter(item => {
      return item.cells[level] == cellId;
    });
  }

  /**
    Tries to add the portal photo when exporting from Ingress.com/intel
  */
  function findPhotos(items) {
    if (!window.portals) {
      return items;
    }
    Object.keys(items).forEach(id => {
      const item = items[id];
      if (item.image)
        return;

      const portal = window.portals[id];
      if (portal && portal.options && portal.options.data) {
        item.image = portal.options.data.image;
      }
    });
    return items;
  }

  function configureGridLevelSelect(select, i) {
    select.value = settings.grids[i].level;
    select.addEventListener('change', e => {
      settings.grids[i].level = parseInt(select.value, 10);
      saveSettings();
      updateMapGrid();
    });
  }

  function showS2Dialog() {
    const selectRow = `
      <p>{{level}} level of grid to display: <select>
      <option value=0>None</option>
      <option value=6>6</option>
      <option value=7>7</option>
      <option value=8>8</option>
      <option value=9>9</option>
      <option value=10>10</option>
      <option value=11>11</option>
      <option value=12>12</option>
      <option value=13>13</option>
      <option value=14>14</option>
      <option value=15>15</option>
      <option value=16>16</option>
      <option value=17>17</option>
      <option value=18>18</option>
      <option value=19>19</option>
      <option value=20>20</option>
      </select></p>`;

    const html =
      selectRow.replace('{{level}}', '1st') +
      selectRow.replace('{{level}}', '2nd') +
      `<!-- p><label><input type="checkbox" id="chkHighlightCandidates">Highlight Cells that might get a Gym</label></p>
      <p><label><input type="checkbox" id="chkHighlightCenters">Highlight centers of Cells with a Gym</label></p -->
      <p><label title='Hide Ingress panes, info and whatever that clutters the map and it is useless for Catan'><input type="checkbox" id="chkThisIsCatan">This is Catan!</label></p>
      <p><label title="Analyze the portal data to show the pane that suggests new POIs"><input type="checkbox" id="chkanalyzeForMissingData">Analyze portal data</label></p>
      <p><a id='CatanEditColors'>Colors</a></p>
       `;

    const container = dialog({
      id: 's2Settings',
      width: 'auto',
      html: html,
      title: 'S2 & Catan Settings'
    });

    const div = container[0];

    const selects = div.querySelectorAll('select');
    for (let i = 0; i < 2; i++) {
      configureGridLevelSelect(selects[i], i);
    }

    const chkThisIsCatan = div.querySelector('#chkThisIsCatan');
    chkThisIsCatan.checked = !!settings.thisIsCatan;
    chkThisIsCatan.addEventListener('change', e => {
      settings.thisIsCatan = chkThisIsCatan.checked;
      saveSettings();
      setThisIsCatan();
    });

    const chkanalyzeForMissingData = div.querySelector('#chkanalyzeForMissingData');
    chkanalyzeForMissingData.checked = !!settings.analyzeForMissingData;
    chkanalyzeForMissingData.addEventListener('change', e => {
      settings.analyzeForMissingData = chkanalyzeForMissingData.checked;
      saveSettings();
      if (newPortals.length > 0) {
        checkNewPortals();
      }
    });

    const CatanEditColors = div.querySelector('#CatanEditColors');
    CatanEditColors.addEventListener('click', function (e) {
      editColors();
      e.preventDefault();
      return false;
    });
  }

  function editColors() {
    const selectRow = `<p class='catan-colors'>{{title}}<br>
      Color: <input type='color' id='{{id}}Color'> Opacity: <select id='{{id}}Opacity'>
      <option value=0>0</option>
      <option value=0.1>0.1</option>
      <option value=0.2>0.2</option>
      <option value=0.3>0.3</option>
      <option value=0.4>0.4</option>
      <option value=0.5>0.5</option>
      <option value=0.6>0.6</option>
      <option value=0.7>0.7</option>
      <option value=0.8>0.8</option>
      <option value=0.9>0.9</option>
      <option value=1>1</option>
      </select></p>`;

    const html =
      selectRow.replace('{{title}}', '1st Grid').replace(/{{id}}/g, 'grid0') +
      selectRow.replace('{{title}}', '2nd Grid').replace(/{{id}}/g, 'grid1') +
      selectRow.replace('{{title}}', 'Border of too close circles').replace(/{{id}}/g, 'nearbyCircleBorder') +
      selectRow.replace('{{title}}', 'Fill of too close circles').replace(/{{id}}/g, 'nearbyCircleFill') +
      '<a id="resetColorsLink">Reset all colors</a>'
      ;

    const container = dialog({
      id: 's2Colors',
      width: 'auto',
      html: html,
      title: 'Catan grid Colors'
    });

    const div = container[0];

    const updatedSetting = function (id) {
      saveSettings();
      if (id == 'nearbyCircleBorder' || id == 'nearbyCircleFill') {
        redrawNearbyCircles();
      } else {
        updateMapGrid();
      }
    };

    const configureItems = function (key, item, id) {
      if (!id)
        id = item;

      const entry = settings[key][item];
      const select = div.querySelector('#' + id + 'Opacity');
      select.value = entry.opacity;
      select.addEventListener('change', function (event) {
        settings[key][item].opacity = select.value;
        updatedSetting(id);
      });

      const input = div.querySelector('#' + id + 'Color');
      input.value = entry.color;
      input.addEventListener('change', function (event) {
        settings[key][item].color = input.value;
        updatedSetting(id);
      });
    };

    configureItems('grids', 0, 'grid0');
    configureItems('grids', 1, 'grid1');
    configureItems('colors', 'nearbyCircleBorder');
    configureItems('colors', 'nearbyCircleFill');

    const resetColorsLink = div.querySelector('#resetColorsLink');
    resetColorsLink.addEventListener('click', function() {
      container.dialog('close');
      resetColors();
      updatedSetting('nearbyCircleBorder');
      updatedSetting();
      editColors();
    });
  }

  /**
   * Refresh the S2 grid over the map
   */
  function updateMapGrid() {
    regionLayer.clearLayers();

    if (!map.hasLayer(regionLayer))
      return;

    const bounds = map.getBounds();
    const seenCells = {};
    const resourcesByCell = {};
    const deltas = [
      {a: -1, b: 0},
      {a: -1, b: -1},
      {a: 0, b: -1},
      {a: 1, b: -1},
      {a: 1, b: 0},
      {a: 1, b: 1},
      {a: 0, b: 1},
      {a: -1, b: 1}
    ];
    const drawCellAndNeighbors = function (cell, color, width, opacity) {
      const cellStr = cell.toString();

      if (!seenCells[cellStr]) {
        // cell not visited - flag it as visited now
        seenCells[cellStr] = true;

        if (isCellOnScreen(bounds, cell)) {
          // on screen - draw it
          drawCell(cell, color, width, opacity);

          // and recurse to our neighbors
          const neighbors = cell.getNeighbors(deltas);
          for (let i = 0; i < neighbors.length; i++) {
            drawCellAndNeighbors(neighbors[i], color, width, opacity);
          }

          // add cell score
          let cellsWithResources = 0;
          let totalResources = 0;
          let hasUnknown = false;
          for (let i = 0; i < neighbors.length; ++i) {
            let data = resourcesByCell[neighbors[i]];
            if (data && data.resources.length) {
              cellsWithResources++;
              totalResources += data.resources.length;
            }
            if (data && data.notClassified.length) {
              hasUnknown = true;
            }
          }

          let data = resourcesByCell[cell];
          if (data && data.notClassified.length) {
            hasUnknown = true;
          }
          let score = data && data.resources.length || 0;
          let scoreMarker;
          if (totalResources > 0) {
            score += totalResources / cellsWithResources;
          }
          if (score > 0) {
            scoreMarker = L.marker(cell.getLatLng(), {
              icon: L.divIcon({
                className: 's2score',
                iconSize: [40, 40],
                iconAnchor: [20, 20],
                html: '<span>' + score.toFixed(1) + (hasUnknown ? '?' : '') + '</span>'
              }),
              clickable: false,
              interactive: false
            });
          }
        }
      }
    };

    // center cell
    const zoom = map.getZoom();
    if (zoom < 5) {
      return;
    }
    // first draw nearby circles at the bottom
    if (16 < zoom) {
      regionLayer.addLayer(nearbyGroupLayer);
    }
    // then draw the cell grid
    for (let i = 0; i < settings.grids.length; i++) {
      const grid = settings.grids[i];
      const gridLevel = grid.level;
      if (gridLevel >= 6 && gridLevel < (zoom + 2)) {
        if (gridLevel === 15) {
          classifyGroup(resourcesByCell, resources, gridLevel, (cell, item) => cell.resources.push(item));
          classifyGroup(resourcesByCell, newPortals, gridLevel, (cell, item) => cell.notClassified.push(item));
        }
        const cell = S2.S2Cell.FromLatLng(getLatLngPoint(map.getCenter()), gridLevel);
        drawCellAndNeighbors(cell, grid.color, grid.width, grid.opacity);
      }
    }
  }

  function getLatLngPoint(data) {
    const result = {
      lat: typeof data.lat == 'function' ? data.lat() : data.lat,
      lng: typeof data.lng == 'function' ? data.lng() : data.lng
    };

    return result;
  }

  function drawCell(cell, color, weight, opacity) {
    // corner points
    const corners = cell.getCornerLatLngs();

    // the level 6 cells have noticible errors with non-geodesic lines - and the larger level 4 cells are worse
    // NOTE: we only draw two of the edges. as we draw all cells on screen, the other two edges will either be drawn
    // from the other cell, or be off screen so we don't care
    const region = L.polyline([corners[0], corners[1], corners[2], corners[3], corners[0]], {fill: false, color: color, opacity: opacity, weight: weight, clickable: false, interactive: false});

    regionLayer.addLayer(region);
  }

  function fillCell(cell, color, opacity) {
    // corner points
    const corners = cell.getCornerLatLngs();

    const region = L.polygon(corners, {color: color, fillOpacity: opacity, weight: 0, clickable: false, interactive: false});
    regionLayer.addLayer(region);
  }

  /**
  *  Writes a text in the center of a cell
  */
  function writeInCell(cell, text) {
    // center point
    let center = cell.getLatLng();

    let marker = L.marker(center, {
      icon: L.divIcon({
        className: 's2check-text',
        iconAnchor: [25, 5],
        iconSize: [50, 10],
        html: text
      }),
      interactive: false
    });
    // fixme, maybe add some click handler

    regionLayer.addLayer(marker);
  }

  // ***************************
  // IITC code
  // ***************************


  // ensure plugin framework is there, even if iitc is not yet loaded
  if (typeof window.plugin !== 'function') {
    window.plugin = function () {};
  }

  // PLUGIN START ////////////////////////////////////////////////////////

  // use own namespace for plugin
  window.plugin.catan = function () {};

  const thisPlugin = window.plugin.catan;
  const KEY_STORAGE = 'plugin-catan';

  /*********************************************************************************************************************/

  // Update the localStorage
  thisPlugin.saveStorage = function () {
    createThrottledTimer('saveStorage', function() {
      localStorage[KEY_STORAGE] = JSON.stringify({
        resources: cleanUpExtraData(resources),
        settlements: cleanUpExtraData(settlements),
        notcatan: cleanUpExtraData(notcatan),
      });
    });
  };

  /**
   * Create a new object where the extra properties of each POI have been removed. Store only the minimum.
   */
  function cleanUpExtraData(group) {
    let newGroup = {};
    Object.keys(group).forEach(id => {
      const data = group[id];
      const newData = {
        guid: data.guid,
        lat: data.lat,
        lng: data.lng,
        name: data.name
      };

      if (data.sponsored)
        newData.sponsored = data.sponsored;

      if (data.rtype)
        newData.rtype = data.rtype;

      newGroup[id] = newData;
    });
    return newGroup;
  }

  // Load the localStorage
  thisPlugin.loadStorage = function () {
    const tmp = JSON.parse(localStorage[KEY_STORAGE] || '{}');
    resources = tmp.resources || {};
    settlements = tmp.settlements || {};
    notcatan = tmp.notcatan || {};
  };

  thisPlugin.createEmptyStorage = function () {
    resources = {};
    settlements = {};
    notcatan = {};
    thisPlugin.saveStorage();

    allPortals = {};
    newPortals = {};

    movedPortals = [];
    missingPortals = {};
  };

  /*************************************************************************/

  thisPlugin.findByGuid = function (guid) {
    if (resources[guid]) {
      return {'type': 'resources', 'store': resources};
    }
    if (settlements[guid]) {
      return {'type': 'settlements', 'store': settlements};
    }
    if (notcatan[guid]) {
      return {'type': 'notcatan', 'store': notcatan};
    }
    return null;
  };

  // Append a 'star' flag in sidebar.
  thisPlugin.onPortalSelectedPending = false;
  thisPlugin.onPortalSelected = function () {
    $('.catanResource').remove();
    $('.catanSettlement').remove();
    $('.notCatan').remove();
    const portalDetails = document.getElementById('portaldetails');
    portalDetails.classList.remove('isResource');

    if (window.selectedPortal == null) {
      return;
    }

    if (!thisPlugin.onPortalSelectedPending) {
      thisPlugin.onPortalSelectedPending = true;

      setTimeout(function () { // the sidebar is constructed after firing the hook
        thisPlugin.onPortalSelectedPending = false;

        $('.catanResource').remove();
        $('.catanSettlement').remove();
        $('.notCatan').remove();

        // Show Catan icons in the mobile status-bar
        if (thisPlugin.isSmart) {
          document.querySelector('.CatanStatus').innerHTML = thisPlugin.htmlStar;
          $('.CatanStatus > a').attr('title', '');
        }

        $(portalDetails).append('<div class="CatanButtons">Catan World Explorers: ' + thisPlugin.htmlStar + '</div>' +
          `<div id="CatanResourceInfo">
          <label for='CatanResourceType'>Type:</label> <select id='CatanResourceType'>
              <option value='Brick'>Brick</option>
              <option value='Sheep'>Sheep</option>
              <option value='Wood'>Wood</option>
              <option value='Wheat'>Wheat</option>
              <option value='Ore'>Ore</option>
              <option value='Unknown'>Unknown</option>
              </select><br>
        </div>`);

        document.getElementById('CatanResourceType').addEventListener('change', ev => {
          const guid = window.selectedPortal;
          const icon = document.getElementById('resource' + guid.replace('.', ''));
          // remove styling of resource marker
          if (icon) {
            icon.classList.remove(resources[guid].rtype + 'Type');
          }
          resources[guid].rtype = ev.target.value;
          thisPlugin.saveStorage();
          // update resource marker
          if (icon) {
            icon.classList.add(resources[guid].rtype + 'Type');
          }
        });

        thisPlugin.updateStarPortal();
      }, 0);
    }
  };

  // Update the status of the star (when a portal is selected from the map/catan-list)
  thisPlugin.updateStarPortal = function () {
    $('.catanResource').removeClass('favorite');
    $('.catanSettlement').removeClass('favorite');
    $('.notCatan').removeClass('favorite');
    document.getElementById('portaldetails').classList.remove('isResource');

    const guid = window.selectedPortal;
    // If current portal is in catan: select catan portal from portals list and select the star
    const catanData = thisPlugin.findByGuid(guid);
    if (catanData) {
      if (catanData.type === 'settlements') {
        $('.catanSettlement').addClass('favorite');
      }
      if (catanData.type === 'resources') {
        $('.catanResource').addClass('favorite');
        document.getElementById('portaldetails').classList.add('isResource');
        const resource = resources[guid];
        if (resource.rtype) {
          document.getElementById('CatanResourceType').value = resource.rtype;
        }

      }
      if (catanData.type === 'notcatan') {
        $('.notCatan').addClass('favorite');
      }
    }
  };

  function removeCatanObject(type, guid) {
    if (type === 'settlements') {
      delete settlements[guid];
      const starInLayer = settlementLayers[guid];
      settlementLayerGroup.removeLayer(starInLayer);
      delete settlementLayers[guid];
    }
    if (type === 'resources') {
      delete resources[guid];
      const resourceInLayer = resourceLayers[guid];
      resourceLayerGroup.removeLayer(resourceInLayer);
      delete resourceLayers[guid];
    }
    if (type === 'notcatan') {
      delete notcatan[guid];
      const notcatanInLayer = notCatanLayers[guid];
      notCatanLayerGroup.removeLayer(notcatanInLayer);
      delete notCatanLayers[guid];
    }
  }

  // Switch the status of the star
  thisPlugin.switchStarPortal = function (type) {
    const guid = window.selectedPortal;

    // It has been manually classified, remove from the detection
    if (newPortals[guid])
      delete newPortals[guid];

    // If portal is saved in Catan: Remove this POI
    const catanData = thisPlugin.findByGuid(guid);
    if (catanData) {
      const existingType = catanData.type;
      removeCatanObject(existingType, guid);

      thisPlugin.saveStorage();
      thisPlugin.updateStarPortal();

      // Get portal name and coordinates
      const p = window.portals[guid];
      const ll = p.getLatLng();
      if (existingType !== type) {
        thisPlugin.addPortalCatan(guid, ll.lat, ll.lng, p.options.data.title, type);
      }
    } else {
      // If portal isn't saved in Catan: Add this POI

      // Get portal name and coordinates
      const portal = window.portals[guid];
      const latlng = portal.getLatLng();
      thisPlugin.addPortalCatan(guid, latlng.lat, latlng.lng, portal.options.data.title, type);
    }
  };

  // Add portal
  thisPlugin.addPortalCatan = function (guid, lat, lng, name, type, rtype) {
    // Add POI in the localStorage
    const obj = {'guid': guid, 'lat': lat, 'lng': lng, 'name': name};

    // prevent that it would trigger the missing portal detection if it's in our data
    if (window.portals[guid]) {
      obj.exists = true;
    }

    if (type == 'resources') {
      obj.rtype = rtype || 'Unknown';
      resources[guid] = obj;
    }
    if (type == 'settlements') {
      settlements[guid] = obj;
    }
    if (type == 'notcatan') {
      notcatan[guid] = obj;
    }

    // updateExtraGymsCells(lat, lng);
    thisPlugin.saveStorage();
    thisPlugin.updateStarPortal();

    thisPlugin.addStar(guid, lat, lng, name, type, obj.rtype);
  };

  /*
    OPTIONS
  */
  // Manual import, export and reset data
  thisPlugin.catanActionsDialog = function () {
    const content = `<div id="catanSetbox">
      <a id="save-dialog" title="Select the data to save from the info on screen">Save...</a>
      <a onclick="window.plugin.catan.optReset();return false;" title="Deletes all Catan markers">Reset Catan portals</a>
      <a onclick="window.plugin.catan.optImport();return false;" title="Import a JSON file with all the Catan data">Import Catan</a>
      <a onclick="window.plugin.catan.optExport();return false;" title="Exports a JSON file with all the Catan data">Export Catan</a>
      <a onclick="window.plugin.catan.exportS2();return false;" title="Exports a JSON file with all the Catan data">Export Catan S2 L15</a>
      </div>`;

    const container = dialog({
      html: content,
      title: 'S2 & Catan Actions'
    });

    const div = container[0];
    div.querySelector('#save-dialog').addEventListener('click', e => saveDialog());
  };

  function saveDialog() {
    const content = `<div>
      <p>Select the data to save from the info on screen</p>
      <fieldset><legend>Which data?</legend>
      <input type='radio' name='CatanSaveDataType' value='Resources' id='CatanSaveDataTypeResources'><label for='CatanSaveDataTypeResources'>Resources</label><br>
      <input type='radio' name='CatanSaveDataType' value='Settlements' id='CatanSaveDataTypeSettlements'><label for='CatanSaveDataTypeSettlements'>Settlements</label><br>
      <input type='radio' name='CatanSaveDataType' value='All' id='CatanSaveDataTypeAll'><label for='CatanSaveDataTypeAll'>All</label>
      </fieldset>
      <fieldset><legend>Format</legend>
      <input type='radio' name='CatanSaveDataFormat' value='CSV' id='CatanSaveDataFormatCSV'><label for='CatanSaveDataFormatCSV'>CSV</label><br>
      <input type='radio' name='CatanSaveDataFormat' value='JSON' id='CatanSaveDataFormatJSON'><label for='CatanSaveDataFormatJSON'>JSON</label>
      </fieldset>
      </div>`;

    function escapeCSV(s) {
      if (s === 0) {
        return '0';
      }
      if (s === undefined || s === null) {
        return '';
      }
      if (/[,"\n]/.test(s)) {
        return '"' + s.replace(/"/g, '""') + '"';
      }

      return s;
    }

    function mapToCSV(arr, type) {
        const data = filterItemsByMapBounds(arr);
        const keys = Object.keys(data);
        return keys.map(id => {
            const poi = data[id];
            return [poi.name, poi.lat, poi.lng, type, poi.rtype].map(escapeCSV).join(',');
        });
    }

    const container = dialog({
      html: content,
      title: 'Save visible data',
      buttons: {
        'Save': function () {
          const SaveDataType = document.querySelector('input[name="CatanSaveDataType"]:checked').value;
          const SaveDataFormat = document.querySelector('input[name="CatanSaveDataFormat"]:checked').value;
          const types = ['Resources', 'Settlements', 'All'];
          if (types.indexOf(SaveDataType) < 0) {
            SaveDataType = 'All';
          }

          settings.saveDataType = SaveDataType;
          settings.saveDataFormat = SaveDataFormat;
          saveSettings();

          container.dialog('close');

          let filename = SaveDataType.toLowerCase() + '_' + (new Date()).toISOString().substr(0, 19).replace(/[\D]/g, '_');
          if (SaveDataFormat == 'CSV') {
            filename += '.csv';
            let rows = [];
            if (SaveDataType == 'All' || SaveDataType == 'Resources') {
                rows = [...rows, ...mapToCSV(resources, 'resource')];
            }
            if (SaveDataType == 'All' || SaveDataType == 'Settlements') {
                rows = [...rows, ...mapToCSV(settlements, 'settlement')];
            }

            saveToFile(rows.join('\n'), filename);
          } else {
            filename += '.json';
            let data = {};
            if (SaveDataType == 'All' || SaveDataType == 'Resources') {
              data.resources = filterItemsByMapBounds(resources);
            };
            if (SaveDataType == 'All' || SaveDataType == 'Settlements') {
              data.settlements = filterItemsByMapBounds(settlements);
            };

            Object.keys(data).forEach(key => {
              data[key] = findPhotos(cleanUpExtraData(data[key]));
            });
            
            saveToFile(JSON.stringify(data), filename);
          }
        }
      }

    });

    // Remove ok button
    const outer = container.parent();
    outer.find('.ui-dialog-buttonset button:first').remove();

    const div = container[0];
    div.querySelector('#CatanSaveDataType' + settings.saveDataType).checked = true;
    div.querySelector('#CatanSaveDataFormat' + settings.saveDataFormat).checked = true;

  };

  thisPlugin.optAlert = function (message) {
    $('.ui-dialog .ui-dialog-buttonset').prepend('<p class="catan-alert" style="float:left;margin-top:4px;">' + message + '</p>');
    $('.catan-alert').delay(2500).fadeOut();
  };

  thisPlugin.optExport = function () {
    saveToFile(localStorage[KEY_STORAGE], 'IITC-catan.json');
  };

  thisPlugin.exportS2 = function () {
    const cells = groupByCell(15);
    const filtered = {};
    Object.keys(cells).forEach(cellId => {
      const cellData = cells[cellId];
      const cell = cellData.cell;

      if (cellData.resources.length || cellData.settlements.length) {
        delete cellData.notClassified;
        delete cellData.notCatan;
        filtered[cellId] = cellData;
      }
    });

    saveToFile(filtered, 'IITC-catan-s2.json');
  };

  thisPlugin.optImport = function () {
    readFromFile(function (content) {
      try {
        const list = JSON.parse(content); // try to parse JSON first
        let importResourceType = true;
        Object.keys(list).forEach(type => {
          for (let idcatan in list[type]) {
            const item = list[type][idcatan];
            const lat = item.lat;
            const lng = item.lng;
            const name = item.name;
            let guid = item.guid;
            if (!guid) {
              guid = findPortalGuidByPositionE6(lat * 1E6, lng * 1E6);
              if (!guid) {
                console.log('portal guid not found', name, lat, lng); // eslint-disable-line no-console
                guid = idcatan;
              }
            }

            if (typeof lat !== "undefined" && typeof lng !== "undefined" && name && !thisPlugin.findByGuid(guid)) {
              thisPlugin.addPortalCatan(guid, lat, lng, name, type, item.rtype);
            }
          }
        });

        thisPlugin.updateStarPortal();
        thisPlugin.resetAllMarkers();
        thisPlugin.optAlert('Successful.');
      } catch (e) {
        console.warn('Catan: failed to import data: ' + e); // eslint-disable-line no-console
        thisPlugin.optAlert('<span style="color: #f88">Import failed </span>');
      }
    });
  };

  thisPlugin.optReset = function () {
    if (confirm('All Catan data will be deleted. Are you sure?', '')) {
      delete localStorage[KEY_STORAGE];
      thisPlugin.createEmptyStorage();
      thisPlugin.updateStarPortal();
      thisPlugin.resetAllMarkers();
      thisPlugin.optAlert('Successful.');
    }
  };

  /* CATAN PORTALS LAYER */
  thisPlugin.addAllMarkers = function () {
    function iterateStore(store, type) {
      for (let idcatan in store) {
        const item = store[idcatan];
        thisPlugin.addStar(item.guid, item.lat, item.lng, item.name, type, item.rtype);
      }
    }

    iterateStore(resources, 'resources');
    iterateStore(settlements, 'settlements');
    iterateStore(notcatan, 'notcatan');
  };

  thisPlugin.resetAllMarkers = function () {
    for (let guid in settlementLayers) {
      const starInLayer = settlementLayers[guid];
      settlementLayerGroup.removeLayer(starInLayer);
      delete settlementLayers[guid];
    }
    for (let resourceGuid in resourceLayers) {
      const resourceInLayer = resourceLayers[resourceGuid];
      resourceLayerGroup.removeLayer(resourceInLayer);
      delete resourceLayers[resourceGuid];
    }
    for (let notcatanGuid in notCatanLayers) {
      const notCatanInLayer = notCatanLayers[notcatanGuid];
      notCatanLayerGroup.removeLayer(notCatanInLayer);
      delete notCatanLayers[notCatanInLayer];
    }
    thisPlugin.addAllMarkers();
  };

  thisPlugin.addStar = function (guid, lat, lng, name, type, rtype) {
    let star;
    if (type === 'settlements') {
      star = new L.Marker.SVGMarker([lat, lng], {
        title: name,
        iconOptions: {
          className: 'settlement',
          // "#b8ac8e"
          // html: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 163.3 410.6"><path class="settlement-base" d="M113.8 351.9l6.6 13.9 1.7 18.8-11 12-60.8 2.5-12.4-3.5-12.3-14.8 2.8-22.7 5.4-2 37-4.2z"/><path class="settlement-steps" d="M38.9 358c-.1 0-2.1 16.2 20.9 18.1 23 1.9 44.7-10.3 44.7-10.3l-33.7-13.9-31.9 6.1z"/><path class="settlement-steps" d="M46.6 360.8s-.3 8.6 13.9 10.3c14.2 1.7 33.6-5.3 33.6-5.3"/><path class="settlement-flag" d="M83.1 37.6l.4-25 21.1 5.7-21.3 4.3"/><path class="settlement-wall" d="M119.4 185.3l-8 85.7-68.3 2.6-4.4-86z"/><path class="settlement-roof" d="M83.1 37.6l44 145 6.3 10s-24.3 5.1-54.3 4.7C50 197 27.4 192 27.4 192l17.3-28.7L83.1 37.6z"/><path class="settlement-window" d="M61.7 156.3l6.5-7.5 8.5 8.5v19.4H62.4z"/><g><path class="settlement-wall settlement-thin" d="M110.8 129.6l-3.3 20s4.8 21.3 14.5 26l9.2-46h-20.4z"/><path class="settlement-roof settlement-thin" d="M130.3 74.3l-25 55.3h31.3z"/><path class="settlement-wall settlement-thin" d="M148.1 120.6l-7.9 40.2h-15.4l8.5-41.6z"/><path class="settlement-roof settlement-thin" d="M150.1 77.6l-22 41.2 24.2 1.8z"/></g><g><path class="settlement-flag" d="M25.1 138.1l-2.7-23 18.7 2.4-17.7 6.1"/><path class="settlement-wall" d="M57.3 228.6l5.8 130.5-16.5 1.7-12.8-4.7-17.2-127.5 14.7 2.2z"/><path class="settlement-roof" d="M16.6 228.6l-6.8-3 6.8-13.3 8.5-74.2 25.5 72 14.2 12-7.5 6.5-26 2.2z"/><path class="settlement-window" d="M23.6 219.2l8.4 11.5v13.4l-8-.8-2.7-14z"/></g><g><path class="settlement-wall" d="M58.8 361.6l21 2 8.3-4.3 4-95.2-14.5 4.7-27.3-4.7z"/><path class="settlement-door" d="M64.8 362.1s-.6-22.2 5.7-21.7c7.1.6 6.2 22.8 6.2 22.8l-11.9-1.1z"/><path class="settlement-roof" d="M47.5 263.6l20.6-53.8 26.3 53.5-16.8 5.5z"/><path class="settlement-window" d="M59.1 265.4l5.9-6.3 5.9 8.5-1.3 15.1H59.1z"/></g><g><path class="settlement-flag" d="M122.1 172.1l2.8-21.6 21 7.8-22.1.3"/><path class="settlement-wall" d="M111.6 365.8l17.5-108-23.8 2.5-15.2-2.5-5 103 9 5z"/><path class="settlement-roof" d="M90.1 257.8l15.2 2.5 23.8-2.5 7.5-6.5-6.3-11.7-8.2-67.5-28.3 68.5-8.7 11.2z"/><path class="settlement-window" d="M111.1 259.7l9.1-10.3 3.4 9-3.8 15.9h-8.7z"/></g></svg>`,
          html: `<svg xmlns="http://www.w3.org/2000/svg" width="31.7544mm" height="50.2779mm" viewBox="0 0 120 190">
  <path id="Selection" fill="#b8ac8e" stroke="black" stroke-width="3" d="M 34.00,55.00
           C 41.26,58.90 36.62,58.99 47.00,59.00 47.00,59.00 44.00,61.00 44.00,61.00 44.00,61.00 39.72,101.00 39.72,101.00
             39.72,101.00 37.05,127.96 37.05,127.96 37.05,127.96 39.00,144.00 39.00,144.00 35.09,144.35 18.15,148.33 15.31,150.27
             13.35,151.61 13.28,152.90 12.05,154.65 10.00,157.57 7.42,158.67 8.33,163.00
             9.16,166.95 13.12,169.92 16.00,172.42 23.88,179.28 23.36,181.98 34.00,182.00
             34.00,182.00 85.00,182.00 85.00,182.00 87.13,182.00 90.00,182.12 92.00,181.41
              93.99,180.70 104.55,172.93 107.00,171.12 109.78,169.07 113.88,166.52 114.67,162.97 115.60,158.72 112.96,157.54 110.95,154.64
              109.76,152.94 109.57,151.43 107.69,150.16 106.30,149.22 101.89,148.23 100.00,147.66 93.28,145.60 88.10,143.33 81.00,143.00
              81.00,143.00 82.95,127.96 82.95,127.96 82.95,127.96 80.28,101.00 80.28,101.00 80.28,101.00 76.00,61.00 76.00,61.00
              76.00,61.00 72.00,61.00 72.00,61.00 72.00,61.00 72.00,59.00 72.00,59.00 72.00,59.00 85.00,55.00 85.00,55.00
              85.00,55.00 85.00,28.00 85.00,28.00 84.99,26.21 85.06,23.75 84.40,22.09 83.36,19.45 73.62,10.62 71.00,8.00
              68.39,5.39 64.68,1.10 61.00,0.33 55.93,-0.72 52.20,3.83 49.00,7.00 45.85,10.13 35.82,18.72 34.60,22.00
              33.89,23.92 34.00,26.93 34.00,29.00 34.00,29.00 34.00,55.00 34.00,55.00 Z
              M 60.00,6.00 C 60.00,6.00 60.00,10.00 60.00,10.00 60.00,10.00 60.00,6.00 60.00,6.00 Z
              M 55.00,11.00 C 55.75,17.08 51.67,19.03 47.00,22.00 47.20,15.84 49.09,13.17 55.00,11.00 Z
              M 72.00,22.00 C 72.00,22.00 62.00,14.00 62.00,14.00 62.00,14.00 63.00,11.00 63.00,11.00
              68.28,13.50 71.05,16.13 72.00,22.00 Z M 71.00,48.00 C 71.00,48.00 47.00,48.00 47.00,48.00
              47.00,48.00 48.02,27.28 48.02,27.28 48.02,27.28 58.00,16.00 58.00,16.00 62.10,17.90 68.78,22.65 70.40,27.00
              71.40,29.69 71.00,44.13 71.00,48.00 Z M 43.00,22.00 C 43.00,22.00 42.00,28.00 42.00,28.00
              40.92,24.97 41.12,24.56 43.00,22.00 Z M 76.00,22.00 C 76.00,22.00 77.00,27.00 77.00,27.00
              77.00,27.00 75.00,27.00 75.00,27.00 75.00,27.00 76.00,22.00 76.00,22.00 Z M 43.00,30.00
              C 43.00,30.00 43.00,48.00 43.00,48.00 43.00,48.00 41.00,48.00 41.00,48.00 41.00,48.00 41.00,30.00 41.00,30.00
              41.00,30.00 43.00,30.00 43.00,30.00 Z M 78.00,30.00 C 78.00,30.00 78.00,48.00 78.00,48.00
              78.00,48.00 75.00,48.00 75.00,48.00 75.00,48.00 75.00,30.00 75.00,30.00 75.00,30.00 78.00,30.00 78.00,30.00 Z
              M 72.00,51.00 C 72.00,51.00 72.00,53.00 72.00,53.00 72.00,53.00 47.00,53.00 47.00,53.00
              47.00,53.00 47.00,51.00 47.00,51.00 47.00,51.00 72.00,51.00 72.00,51.00 Z M 74.00,143.00
              C 74.00,143.00 46.00,143.00 46.00,143.00 46.00,143.00 47.29,122.00 47.29,122.00
              47.29,122.00 48.96,112.00 48.96,112.00 48.96,112.00 48.96,102.00 48.96,102.00 48.96,102.00 50.73,90.00 50.73,90.00
              51.37,85.53 51.22,74.72 56.13,73.17 57.22,73.00 59.82,72.98 61.00,73.17 69.02,73.31 67.81,79.32 69.00,88.00
              69.00,88.00 71.04,102.00 71.04,102.00 71.04,102.00 71.04,112.00 71.04,112.00 71.04,112.00 72.71,122.00 72.71,122.00
              72.71,122.00 74.00,143.00 74.00,143.00 Z M 39.00,154.00 C 39.00,154.00 38.00,168.00 38.00,168.00
              38.00,168.00 24.00,162.00 24.00,162.00 24.00,162.00 39.00,154.00 39.00,154.00 Z M 103.00,160.00
              C 103.00,160.00 92.00,163.60 92.00,163.60 92.00,163.60 84.00,167.00 84.00,167.00 84.00,167.00 82.00,155.00 82.00,155.00
              90.51,155.00 96.17,153.86 103.00,160.00 Z" /></svg>`,
          iconSize: L.point(30, 72),
          iconAnchor: [15, 48]
        }
      });

    }
    if (type === 'resources') {
      const className = 'resource ' + rtype + 'Type';
      star = new L.Marker.SVGMarker([lat, lng], {
        title: name,
        iconOptions: {
          id: 'resource' + guid.replace('.', ''),
          className: className,
          //html: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 310 425.3"><path class="resource-wall" d="M63.3 395l-13.2-99.2L169.8 94l73.3 116.5 4 102.3-4 89.7-25 15.8-127-5.3z"/><path class="resource-door" d="M153.7 413v-64s2-17.3 27.7-16.3 27.3 19 27.3 19l1.7 63.3-56.7-2z"/><path class="resource-window" d="M88.8 338l37.5-2.5 4.4 59.7-39.4-2z"/><path class="resource-roof" d="M121 76.7L8 53l15 135L8 293.3 53.3 311l67 2 38.7-92.3 14-95L211.3 227l24.4 87.7 65.6-10.6L281 187.3 285 50l-71.3 22.3z"/><g class="resource-tower"><path class="resource-roof" d="M91 7.3L57.3 54.8l2 50.7 58.1 11 7.9-59.8z"/><path class="resource-window" d="M75.1 65.1h28L100.3 93l-23.7-1.7z"/></g></svg>`,
          html: `<svg xmlns="http://www.w3.org/2000/svg" width="35.7237mm" height="47.6316mm" viewBox="0 0 135 180">
<path id="Selection" fill="#e6dbbb" stroke="black" stroke-width="4" d="M 51.00,66.00 C 51.00,66.00 58.00,124.09 58.00,124.09
             58.00,124.09 45.00,124.09 45.00,124.09
             45.00,124.09 10.00,132.00 10.00,132.00
             10.00,132.00 11.00,137.00 11.00,137.00
             0.84,139.68 3.36,145.85 8.98,152.00
             12.66,156.02 20.28,165.66 25.00,167.74
             26.94,168.12 29.91,168.00 32.00,167.74
             32.00,167.74 96.00,167.74 96.00,167.74
             98.02,168.00 101.11,168.08 103.00,167.74
             107.28,166.42 117.97,157.42 122.00,154.33
             125.49,151.67 130.15,149.72 130.85,144.97
             131.79,138.55 127.99,138.76 125.58,136.31
             125.58,136.31 122.42,131.73 122.42,131.73
             120.32,129.81 112.09,128.46 109.00,127.79
             88.69,123.40 97.73,124.00 76.00,124.00
             76.00,124.00 83.00,66.14 83.00,66.14
             85.03,66.70 86.55,67.60 88.62,66.14
             90.10,65.33 91.68,62.52 92.58,61.00
             95.01,56.86 102.82,45.36 101.98,41.00
             101.42,38.13 92.48,23.50 90.40,20.00
             89.35,18.22 86.72,13.01 85.32,11.99
             83.70,10.83 80.92,11.01 79.00,11.00
             79.00,11.00 57.00,11.00 57.00,11.00
             55.06,11.00 51.86,10.88 50.10,11.60
             45.96,13.29 40.33,25.75 37.80,30.00
             36.19,32.71 31.98,39.04 31.99,42.00
             32.00,44.51 34.32,47.83 35.58,50.00
             37.41,53.16 43.69,65.69 46.33,66.84
             48.28,67.69 49.35,66.75 51.00,66.00 Z
           M 75.00,30.00
           C 75.00,30.00 80.76,41.00 80.76,41.00
             81.70,44.25 80.48,46.19 78.99,49.00
             77.97,50.93 76.54,53.75 74.66,54.95
             72.27,56.42 61.70,56.43 59.38,54.95
             57.11,53.56 53.27,46.65 53.19,44.00
             53.12,41.68 54.88,39.00 55.99,37.00
             57.21,34.81 58.65,31.59 61.21,30.77
             61.21,30.77 75.00,30.00 75.00,30.00 Z" /></svg>`,
          iconSize: L.point(32, 40),
          iconAnchor: [16, 30]
        }
      });
    }

    if (type === 'notcatan') {
      star = new L.Marker.SVGMarker([lat, lng], {
        title: name,
        iconOptions: {
          className: 'notcatan',
          html: '<span>N/A</span>',
          iconSize: L.point(24, 24),
          iconAnchor: [12, 12]
        }
      });
    }

    if (!star)
      return;

    window.registerMarkerForOMS(star);
    star.on('spiderfiedclick', function () {
      // don't try to render fake portals
      if (guid.indexOf('.') > -1) {
        renderPortalDetails(guid);
      }
    });

    if (type === 'settlements') {
      settlementLayers[guid] = star;
      star.addTo(settlementLayerGroup);
    }
    if (type === 'resources') {
      resourceLayers[guid] = star;
      star.addTo(resourceLayerGroup);
    }
    if (type === 'notcatan') {
      notCatanLayers[guid] = star;
      star.addTo(notCatanLayerGroup);
    }
  };

  thisPlugin.setupCSS = function () {
    $('<style>').prop('type', 'text/css').html(`
#sidebar #portaldetails h3.title{
  width:auto;
}
.catanSettlement span,
.catanResource span {
  display:inline-block;
  float:left;
  margin:3px 1px 0 4px;
  width:24px;
  height:24px;
  overflow:hidden;
  background-repeat:no-repeat;
  background-size:contain;
}
.catanSettlement span,
.catanResource span {
  filter:grayscale(100%);
}
.catanSettlement:focus span, .catanSettlement.favorite span,
.catanResource:focus span, .catanResource.favorite span {
  filter:none;
}

/**********************************************
  DIALOG BOX
**********************************************/

/*---- Options panel -----*/
#catanSetbox a{
  display:block;
  color:#ffce00;
  border:1px solid #ffce00;
  padding:3px 0;
  margin:10px auto;
  width:80%;
  text-align:center;
  background:rgba(8,48,78,.9);
}
#catanSetbox a.disabled,
#catanSetbox a.disabled:hover{
  color:#666;
  border-color:#666;
  text-decoration:none;
}

#catanSetbox{
  text-align:center;
}
.catanSettlement span {
  background-image:url(data:image/png;base64,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);
}
.catanResource span {
  background-image:url(data:image/png;base64,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bXA6ZG9jaWQ6Z2ltcDo5ZDMzNTgxYy0yMjFiLTQ1NWItYWYyMi00ZGRlNTY1ZmNkNGUiCiAgIHhtcE1NOkluc3RhbmNlSUQ9InhtcC5paWQ6NzlhZjhlNjgtOTJmMi00NDNhLWFjMWItNmMyN2M0NmViNGY5IgogICB4bXBNTTpPcmlnaW5hbERvY3VtZW50SUQ9InhtcC5kaWQ6NGNkYjI0ZWMtYjVkNy00Y2FjLWI0YjQtMTE1YjNkZWU0MTFlIgogICBHSU1QOkFQST0iMi4wIgogICBHSU1QOlBsYXRmb3JtPSJXaW5kb3dzIgogICBHSU1QOlRpbWVTdGFtcD0iMTU5NDMxODAxMjE5MDk0NSIKICAgR0lNUDpWZXJzaW9uPSIyLjEwLjE4IgogICBkYzpGb3JtYXQ9ImltYWdlL3BuZyIKICAgeG1wOkNyZWF0b3JUb29sPSJHSU1QIDIuMTAiPgogICA8aXB0Y0V4dDpMb2NhdGlvbkNyZWF0ZWQ+CiAgICA8cmRmOkJhZy8+CiAgIDwvaXB0Y0V4dDpMb2NhdGlvbkNyZWF0ZWQ+CiAgIDxpcHRjRXh0OkxvY2F0aW9uU2hvd24+CiAgICA8cmRmOkJhZy8+CiAgIDwvaXB0Y0V4dDpMb2NhdGlvblNob3duPgogICA8aXB0Y0V4dDpBcnR3b3JrT3JPYmplY3Q+CiAgICA8cmRmOkJhZy8+CiAgIDwvaXB0Y0V4dDpBcnR3b3JrT3JPYmplY3Q+CiAgIDxpcHRjRXh0OlJlZ2lzdHJ5SWQ+CiAgICA8cmRmOkJhZy8+CiAgIDwvaXB0Y0V4dDpSZWdpc3RyeUlkPgogICA8eG1wTU06SGlzdG9yeT4KICAgIDxyZGY6U2VxPgogICAgIDxyZGY6bGkKICAgICAgc3RFdnQ6YWN0aW9uPSJzYXZlZCIKICAgICAgc3RFdnQ6Y2hhbmdlZD0iLyIKICAgICAgc3RFdnQ6aW5zdGFuY2VJRD0ieG1wLmlpZDpmYjQyOTRiYy1iZmQwLTQwNjgtYTA1Ni1kNTkzMzhmZmMxZTMiCiAgICAgIHN0RXZ0OnNvZnR3YXJlQWdlbnQ9IkdpbXAgMi4xMCAoV2luZG93cykiCiAgICAgIHN0RXZ0OndoZW49IjIwMjAtMDctMDlUMTE6MDY6NTIiLz4KICAgIDwvcmRmOlNlcT4KICAgPC94bXBNTTpIaXN0b3J5PgogICA8cGx1czpJbWFnZVN1cHBsaWVyPgogICAgPHJkZjpTZXEvPgogICA8L3BsdXM6SW1hZ2VTdXBwbGllcj4KICAgPHBsdXM6SW1hZ2VDcmVhdG9yPgogICAgPHJkZjpTZXEvPgogICA8L3BsdXM6SW1hZ2VDcmVhdG9yPgogICA8cGx1czpDb3B5cmlnaHRPd25lcj4KICAgIDxyZGY6U2VxLz4KICAgPC9wbHVzOkNvcHlyaWdodE93bmVyPgogICA8cGx1czpMaWNlbnNvcj4KICAgIDxyZGY6U2VxLz4KICAgPC9wbHVzOkxpY2Vuc29yPgogIDwvcmRmOkRlc2NyaXB0aW9uPgogPC9yZGY6UkRGPgo8L3g6eG1wbWV0YT4KICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAKICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgCiAgICAgICAgICAgICAgICAgICAgICAgICAgIAo8P3hwYWNrZXQgZW5kPSJ3Ij8+0wdUsAAAAAZiS0dEAP8AAAAAMyd88wAAAAlwSFlzAAAOwwAADsMBx2+oZAAAAAd0SU1FB+QHCRIGNOZlRIMAAAWpSURBVEjHnZZbiN5XFcV/+5zz/64zTWYmyUxa2iTGtEKSaY32YhJiwTSiREJQRAoKvoiKPqhFkbSKFYq2ILaYFxUCVSyxVlJKqdXSFKsYjc3UXCfNPWmTTCaZmW/mu/0vZ28fvsHSl0Q9r4d91l57r3X2Fm5wlq4ssfq+m7lv3cgwxE+p2oVofv/RsfNTLzxz6UbhyPUu71jXxyc+s2KgUtWvLxzhq6WE4W4KUrhLc1P5U2la2vni7lNz42Ot/x5gYDjwofUjbNw4UhWvX+wbbO8QkZuzEphCYRGHUCWQZZydvmZP5Op/sf+Vy/nrL09eH+CeTQv55PZlZbx/MBnIdiT1uLIxm5PnSjTQaKDgghC8p1J2lEtCuyHjnSn5IWnyu5f3nM4Oj829F+ChJ0ZxRRF84rf3LfCPeCdrW75FlhrqFABVxQycE0JwYEKWRgJCtRYQC9Zt6htpIz7mQ/35l/ac1CP75pANWxaz/v6lo7Wh/OdSsXvURWnOKRlKuVSi08lZObyFejLI+IXf4MsO7x1gqEKMPWbVEpTLQqcTtZgNf0vb4eGkGl6Tbzw6urBcjW8ki7P3iQgzjRwXHNE8tw9vY+OazQwtHKYIBWfOH+cP+3ZhkuFLl4mqmBoajVgYiYNy3WGFYM3Q6jbcaqdqa5K6rkCMbhqRxEg7Cdvu/gFbNzxI1o688OfdXJ2cYPnIKr687TE+v/kRslwIiceLkCSOkDgKE1QFc0Z0sYbaSAheY64FRGi1FFdVRpdtZ8WtqyhiRrW/zL1rN7FoYDHdvM2vXnySVjqFrwTSjkJUfAlMIknZ020r1br7j3xCMDkTM7HUooj0mnl55gzgMIlUazWq1IgaCaHMF7Z/GwF8VMSE5uw0z+x9EnVvkWUFGgVTQ+YRXDvT2zRBighqILHE1dY/+PVLP+OdqbOIeEQcZgZmeDVctJ4ABfoWDLFt01foZApSwhC6KagIGDiDkhnkeQR6ZhJxnLm6j1p/hX+N/5Nmu4GIIPN5ifQUbgiKsnhohKH6mndtJe+awFkOGkEVimgUMRK1wFDGj55gYGAJ5j0YpFnKlakJnPM4UUS0Vy4XqCdLKDKIppgqzgxTh+tlYngvmEGM1mNBwS2LltNpNXF4rkxf5lrjGrv/+DSzrVkOjh/Eepxpd+Y4N/EmMB8rggloYbhcvKkawQuqBiZoFKpJwbOvPsWyRbcyWOrj0MnDNLsdEqlx5OQxLkxeJKnUabamuPDOaYRJvOQA+OBQ8USLOEwFhXIpoGoIHjXDTCB5m588t4OxYwf58Oh62p0mW9ZvZWhgADXjxKmj/PK5XSxbupJ22k+uhncCKgQniDicaUSiYWrUKglFjKhClhsxKqF0maf3fgcRx/FT4ywZHGbX73/MsXO/ZebaHPff+XG0cCwbWk9XjXLFIfQ+Q4fDieNIt8ElVcV7xQcwNZjvR1TwztOeTXn70jk6zYKbqkuQEDl29hCtbotDbx0m73bpCyXIAtVymU5DJ4FzsuFjQ6y+a+guqu5HSX/xgOtT121F0tRwThABcY5WO6dcdhTdMqUaJCGniEr0guUwVK9Q70vIW6TNmeIVacq3Do1NHheA4dsSPvulVa41LZtDf/pd8Xw0VJFuJxJF5xsnmNm86cA5xRQqiae/P+BUipmrujObLv/04sTM2Tdfv8LF89l7B86ddy/gI5tvCdEVW0n0e+U+PqiJkWe9x6IqXkCc4INQq3lC9LQauq87579WqSQHdn7/kF13ZC4Y9NyxdiHr7l1eiqLbfLX9sK8Xo1R6ThdVPIE+d5N2O3qgMREfT2qVPQf+cjb/+95r/9vQ/+bjo1LE2Neaip/z9fwhX9f3h+Bxael0t6mPmvHs2F8nuvtfm/7/tooPrKszuKRKqDrW3j7Qn3bt05nW2uWy/9OpE5emX33+4g3Xln8D/07sueykO+wAAAAASUVORK5CYII=);
}

.CatanButtons {
  color: #fff;
  padding: 3px;
}

.CatanButtons span {
  float: none;
}

.notCatan span {
    color: #FFF;
    background: #000;
    border-radius: 50%;
    font-size: 10px;
    letter-spacing: -0.15em;
    display: inline-block;
    opacity: 0.6;
    margin: 3px 1px 0 2px;
    height: 24px;
    width: 24px;
    box-sizing: border-box;
}

.notCatan span:after {
    display: inline-block;
    content: "N/A";
    position: absolute;
    width: 24px;
    line-height: 24px;
    text-align: center;
    vertical-align: middle;
}

.notCatan:focus span, .notCatan.favorite span {
  opacity: 1;
}

.s2check-text {
  text-align: center;
  font-weight: bold;
  border: none !important;
  background: none !important;
  font-size: 130%;
  color: #000;
  text-shadow: 1px 1px #FFF, 2px 2px 6px #fff, -1px -1px #fff, -2px -2px 6px #fff;
}

#CatanResourceInfo {
  display: none;
    padding: 3px;
}

.isResource #CatanResourceInfo {
  display: block;
}

.thisIsCatan .layer_off_warning,
.thisIsCatan .mods,
.thisIsCatan #randdetails,
.thisIsCatan #resodetails,
.thisIsCatan #level {
    display: none;
}

.thisIsCatan #playerstat,
.thisIsCatan #gamestat,
.thisIsCatan #redeem,
.thisIsCatan #chat,
.thisIsCatan #artifactLink,
.thisIsCatan #scoresLink,
.thisIsCatan #chatinput,
.thisIsCatan #chatcontrols {
    display: none;
}

.thisIsCatan #mobileinfo .portallevel,
.thisIsCatan #mobileinfo .resonator {
    display: none;
}

.thisIsCatan #sidebar #portaldetails h3.title {
  color: #fff;
}

.resource {
    opacity: 0.8;
    stroke: #888;
}

.resource-wall{fill:#ddd;stroke-width:8;}
.resource-door{fill:#534C39;stroke-width:8;}
.resource-window{fill:#EBC360;stroke-width:4;}
.resource-roof{fill:#ddd;stroke-width:10;}
.resource-tower .resource-roof{stroke-width:5;}

.GreenColor {
  stroke: #4b474a;
}
.GreenColor .resource-wall {
  fill: #6a686f;
}
.GreenColor .resource-roof {
  fill: #59672e;
}

.PinkColor {
  stroke: #61646b;
}
.PinkColor .resource-wall {
  fill: #5b306f;
}
.PinkColor .resource-roof {
  fill: #1c6775;
}

.BlueColor {
  stroke: #45527c;
}
.BlueColor .resource-wall {
  fill: #868692;
}
.BlueColor .resource-roof {
  fill: #4162a9;
}

.BrownColor {
  stroke: #5b5c5e;
}
.BrownColor .resource-wall {
  fill: #6a7d7f;
}
.BrownColor .resource-roof {
  fill: #6b4a2e;
}

.PurpleColor {
  stroke: #47408e;
}
.PurpleColor .resource-wall {
  fill: #758093;
}
.PurpleColor .resource-roof {
  fill: #664b77;
}

.WhiteColor {
  stroke: #312c27;
}
.WhiteColor .resource-wall {
  fill: #b4b1a9;
}
.WhiteColor .resource-roof {
  fill: #2f4c58;
}

.smallresources .resource {
    opacity: 0.9;
}

.smallresources .resource svg {
  transform: scale(0.8);
}

.s2score {
  color: red;
  opacity: 0.8;
  background-color: #fff;
  border-radius: 50%;
  box-sizing: border-box;
  text-align: center;
  line-height: 40px;
  vertical-align: middle;
}

.notcatan {
  opacity: 0.9;
  color: #fff;
  background-color: #ccc;
  border: solid 1px #aaa;
  border-radius: 50%;
  box-sizing: border-box;
  line-height: 22px;
  vertical-align: middle;
  text-align: center;
  font-size: 10px;
}

.settlement {
  stroke:#373F4E;
}
.settlement-base{fill:#68655E;stroke-width:8;}
.settlement-steps{fill:#BDB9AD;stroke-width:2;}
.settlement-flag{fill:#CB5E35;stroke-width:2;}
.settlement-wall{fill:#8D7F65;stroke-width:6;}
.settlement-roof{fill:#D3867C;stroke-width:6;}
.settlement-window{fill:#FAE792;stroke-width:2;}
.settlement-thin{stroke-width:4;}
.settlement-door{fill:#62463A;stroke-width:2;}


.CatanClassification div {
    display: grid;
    grid-template-columns: 200px 70px 90px 35px;
    text-align: center;
    align-items: center;
    height: 140px;
    overflow: hidden;
  margin-bottom: 10px;
}

.CatanClassification div:nth-child(odd) {
  background: rgba(7, 42, 69, 0.9);
}

.CatanClassification img {
    max-width: 200px;
  max-height: 140px;
    display: block;
    margin: 0 auto;
}

#dialog-missingPortals .CatanClassification div {
  height: 50px;
}

img.photo,
.ingressLocation,
.catanLocation {
    cursor: zoom-in;
}

.Catan-PortalAnimation {
  width: 30px;
  height: 30px;
  background-color: rgba(255, 255, 255, 0.5);
  border-radius: 50%;
  box-shadow: 0px 0px 4px white;
  animation-duration: 1s;
  animation-name: shrink;
}

@keyframes shrink {
  from {
    width: 30px;
    height: 30px;
    top: 0px;
    left: 0px;
  }

  to {
    width: 10px;
    height: 10px;
    top: 10px;
    left: 10px;
  }
}

.Catan-PortalAnimationHover {
  background-color: rgb(255, 102, 0, 0.8);
  border-radius: 50%;
  animation-duration: 1s;
  animation-name: shrinkHover;
  animation-iteration-count: infinite;
}

@keyframes shrinkHover {
  from {
    width: 40px;
    height: 40px;
    top: 0px;
    left: 0px;
  }

  to {
    width: 20px;
    height: 20px;
    top: 10px;
    left: 10px;
  }
}

#sidebarCatan {
    color: #eee;
    padding: 2px 5px;
}

#sidebarCatan span {
    margin-right: 5px;
}

.refreshingData,
.refreshingPortalCount {
    opacity: 0.5;
  pointer-events: none;
}

#sidebarCatan.mobile {
    width: 100%;
    background: rebeccapurple;
    display: flex;
}

#sidebarCatan.mobile > div {
    margin-right: 1em;
}

.catan-colors input[type=color] {
  border: 0;
  padding: 0;
}

`).appendTo('head');
  };

  // A portal has been received.
  function onPortalAdded(data) {
    const guid = data.portal.options.guid;

    data.portal.on('add', function () {
      addNearbyCircle(guid);
    });

    data.portal.on('remove', function () {
      removeNearbyCircle(guid);
    });

    // analyze each portal only once, but sometimes the first time there's no additional data of the portal
    if (allPortals[guid] && allPortals[guid].name)
      return;

    const portal = {
      guid: guid,
      name: data.portal.options.data.title,
      lat: data.portal._latlng.lat,
      lng: data.portal._latlng.lng,
      image: data.portal.options.data.image,
      cells: {}
    };

    allPortals[guid] = portal;

    // If it's already classified in Catan, get out
    const catanData = thisPlugin.findByGuid(guid);
    if (catanData) {
      const catanItem = catanData.store[guid];
      if (!catanItem.exists) {
        // Mark that it still exists in Ingress
        catanItem.exists = true;

        if (missingPortals[guid]) {
          delete missingPortals[guid];
          updateMissingPortalsCount();
        }

        // Check if it has been moved
        if (catanItem.lat != portal.lat || catanItem.lng != portal.lng) {
          movedPortals.push({
            catan: catanItem,
            ingress: portal
          });
          updateCounter('moved', movedPortals);
        }
      }
      if (!catanItem.name && portal.name) {
        catanData.store[guid].name = portal.name;
      }
      return;
    }

    if (skippedPortals[guid]/* || newPokestops[guid]*/)
      return;

    newPortals[guid] = portal;

    refreshNewPortalsCounter();
  }

  /**
   * Draw a 20m circle around a portal
   */
  function addNearbyCircle(guid) {
    const portal = window.portals[guid];
    if (!portal)
      return;

    const circleSettings = {
      color: settings.colors.nearbyCircleBorder.color,
      opacity: settings.colors.nearbyCircleBorder.opacity,
      fillColor: settings.colors.nearbyCircleFill.color,
      fillOpacity: settings.colors.nearbyCircleFill.opacity,
      weight: 1,
      clickable: false,
      interactive: false
    };

    const center = portal._latlng;
    const circle = L.circle(center, 20, circleSettings);
    nearbyGroupLayer.addLayer(circle);
    nearbyCircles[guid] = circle;
  }

  /**
   * Removes the 20m circle if a portal is purged
   */
  function removeNearbyCircle(guid) {
    const circle = nearbyCircles[guid];
    if (circle != null) {
      nearbyGroupLayer.removeLayer(circle);
      delete nearbyCircles[guid];
    }
  }

  function redrawNearbyCircles() {
    const keys = Object.keys(nearbyCircles);
    keys.forEach(guid => {
      removeNearbyCircle(guid);
      addNearbyCircle(guid);
    });
  }

  function refreshNewPortalsCounter() {
    if (!settings.analyzeForMissingData)
      return;

    // workaround for https://bugs.chromium.org/p/chromium/issues/detail?id=961199
    try
    {
      if (checkNewPortalsTimout) {
        clearTimeout(checkNewPortalsTimout);
      } else {
        document.getElementById('sidebarCatan').classList.add('refreshingPortalCount');
      }
    } catch (e) {
      // nothing
    }

    // workaround for https://bugs.chromium.org/p/chromium/issues/detail?id=961199
    try
    {
      checkNewPortalsTimout = setTimeout(checkNewPortals, 1000);
    } catch (e) {
      checkNewPortals();
    }
  }

  /**
   * A potential new portal has been received
   */
  function checkNewPortals() {
    checkNewPortalsTimout = null;

    // don't try to classify if we don't have all the portal data
    if (map.getZoom() < 15)
      return;

    document.getElementById('sidebarCatan').classList.remove('refreshingPortalCount');

    // newPokestops = {};
    notClassifiedPois = [];

    const allCells = groupByCell(17);

    // Check only the items inside the screen,
    // the server might provide info about remote portals if they are part of a link
    // and we don't know anything else about nearby portals of that one.
    // In this case (vs drawing) we want to filter only cells fully within the screen
    const cells = filterWithinScreen(allCells);

    // try to guess new pois if they are the only items in a cell
    Object.keys(cells).forEach(id => {
      const data = allCells[id];
      checkIsPortalMissing(data.resources, data);
      checkIsPortalMissing(data.settlements, data);

      if (data.notClassified.length == 0)
        return;
      const notClassified = data.notClassified;

      if (data.resources.length || data.settlements.length) {
        // Already has a catan item, ignore the rest
        notClassified.forEach(portal => {
          skippedPortals[portal.guid] = true;
          delete newPortals[portal.guid];
        });
        return;
      }

      // too many items to guess
      notClassifiedPois.push(data.notClassified);
    });

    updateCounter('classification', notClassifiedPois);
    updateMissingPortalsCount();

  }

  /**
   * Filter the missing portals detection to show only those on screen and reduce false positives
   */
  function updateMissingPortalsCount() {
    const keys = Object.keys(missingPortals);
    if (keys.length == 0)
      updateCounter('missing', []);

    const bounds = map.getBounds();
    const filtered = [];
    keys.forEach(guid => {
      const catanData = thisPlugin.findByGuid(guid);
      const item = catanData.store[guid];
      if (isPointOnScreen(bounds, item)) {
        filtered.push(item);
      }
    });
    updateCounter('missing', filtered);
  }

  /**
   * Given an array of Catan items checks if they have been removed from Ingress
   */
  function checkIsPortalMissing(array, cellData) {
    array.forEach(item => {
      if (item.exists || item.newGuid)
        return;
      const guid = item.guid;

      if (findCorrectGuid(item, cellData.notClassified)) {
        return;
      }
      if (!missingPortals[guid]) {
        missingPortals[guid] = true;
      }
    });
  }

  /**
   * Check if there's another real portal in the same cell (we're checking a poi that doesn't exist in Ingress)
   */
  function findCorrectGuid(catanItem, array) {
    const portal = array.find(x => x.name == catanItem.name && x.guid != catanItem.guid);
    if (portal != null) {
      catanItem.newGuid = portal.guid;
      movedPortals.push({
        catan: catanItem,
        ingress: portal
      });
      updateCounter('moved', movedPortals);

      delete missingPortals[catanItem.guid];

      return true;
    }
    return false;
  }

  function getCellScores() {
    const allCells = groupByCell(15);
    const cells = filterWithinScreen(allCells);

    const cellIndex = {};
    Object.keys(cells).forEach(id => {
      const cell = allCells[id];
      cellIndex[cell.cell] = cell;
    });

    return cellIndex;
  }

  /**
   * In a level 17 cell there's more than one portal, ask which one is in Catan
   */
  function promptToClassifyPois() {
    updateCounter('classification', notClassifiedPois);
    if (notClassifiedPois.length == 0)
      return;

    const group = notClassifiedPois.shift();
    const div = document.createElement('div');
    div.className = 'CatanClassification';
    group.sort(sortByName).forEach(portal => {
      const wrapper = document.createElement('div');
      wrapper.setAttribute('data-guid', portal.guid);
      const img = getPortalImage(portal);
      wrapper.innerHTML = '<span class="CatanName">' + getPortalName(portal) +
        img + '</span>' +
        '<a data-type="settlements">' + 'SETTLEMENT' + '</a> ' +
        '<a data-type="resources">' + 'RESOURCE' + '</a>';
      div.appendChild(wrapper);
    });
    const container = dialog({
      id: 'classifyPoi',
      html: div,
      width: '420px',
      title: 'Which one is in Catan?',
      buttons: {
        // Button to allow skip this cell
        Skip: function () {
          container.dialog('close');
          group.forEach(portal => {
            delete newPortals[portal.guid];
            skippedPortals[portal.guid] = true;
          });
          // continue
          promptToClassifyPois();
        }
      }
    });
    // Remove ok button
    const outer = container.parent();
    outer.find('.ui-dialog-buttonset button:first').remove();

    // mark the selected one as resource or settlement
    container.on('click', 'a', function (e) {
      const type = this.getAttribute('data-type');
      const guid = this.parentNode.getAttribute('data-guid');
      const portal = getPortalSummaryFromGuid(guid);
      thisPlugin.addPortalCatan(guid, portal.lat, portal.lng, portal.name, type);


      group.forEach(tmpPortal => {
        delete newPortals[tmpPortal.guid];
      });

      container.dialog('close');
      // continue
      promptToClassifyPois();
    });
    container.on('click', 'img.photo', centerPortal);
    configureHoverMarker(container);
  }

  /**
   * List of portals that have been moved
   */
  function promptToMovePois() {
    if (movedPortals.length == 0)
      return;

    const div = document.createElement('div');
    div.className = 'CatanClassification';
    movedPortals.sort(sortByName).forEach(pair => {
      const portal = pair.ingress;
      const catanItem = pair.catan;
      const wrapper = document.createElement('div');
      wrapper.setAttribute('data-guid', portal.guid);
      wrapper.dataPortal = portal;
      wrapper.dataCatanGuid = catanItem.guid;
      const img = getPortalImage(portal);
      wrapper.innerHTML = '<span class="CatanName">' + getPortalName(portal) +
        img + '</span>' +
        '<span><span class="ingressLocation">' + 'Ingress location' + '</span></span>' +
        '<span><span class="catanLocation" data-lat="' + catanItem.lat + '" data-lng="' + catanItem.lng + '">' + 'Catan location' + '</span><br>' +
        '<a>' + 'Update' + '</a></span>';
      div.appendChild(wrapper);
    });
    const container = dialog({
      id: 'movedPortals',
      html: div,
      width: '420px',
      title: 'These portals have been moved in Ingress',
      buttons: {
        // Button to move all the portals at once
        'Update all': function () {
          container.dialog('close');
          movedPortals.forEach(pair => {
            const portal = pair.ingress;
            const catanItem = pair.catan;
            moveCatan(portal, catanItem.guid);
          });
          movedPortals.length = 0;
          updateCounter('moved', movedPortals);

          thisPlugin.saveStorage();
        }
      }
    });

    // Update location
    container.on('click', 'a', function (e) {
      const row = this.parentNode.parentNode;
      const portal = row.dataPortal;
      moveCatan(portal, row.dataCatanGuid);

      thisPlugin.saveStorage();
      if (settings.highlightCatanCandidateCells) {
        updateMapGrid();
      }

      $(row).fadeOut(200);

      // remove it from the list of portals
      const idx = movedPortals.findIndex(pair => pair.ingress.guid == pair.ingress.guid);
      movedPortals.splice(idx, 1);
      updateCounter('moved', movedPortals);

      if (movedPortals.length == 0)
        container.dialog('close');
    });
    container.on('click', 'img.photo', centerPortal);
    container.on('click', '.ingressLocation', centerPortal);
    container.on('click', '.catanLocation', centerPortalAlt);
    configureHoverMarker(container);
    configureHoverMarkerAlt(container);
  }

  /**
   * Update location of a Catan item
   */
  function moveCatan(portal, catanGuid) {
    const guid = portal.guid;
    const catanData = thisPlugin.findByGuid(catanGuid);

    const existingType = catanData.type;
    // remove marker
    removeCatanObject(existingType, guid);

    // Draw new marker
    thisPlugin.addPortalCatan(guid, portal.lat, portal.lng, portal.name || catanData.name, existingType, catanData.type);
  }

  /**
   * Catan items that aren't in Ingress
   */
  function promptToRemovePois(missing) {
    const div = document.createElement('div');
    div.className = 'CatanClassification';
    missing.sort(sortByName).forEach(portal => {
      const wrapper = document.createElement('div');
      wrapper.setAttribute('data-guid', portal.guid);
      const name = portal.name || 'Unknown';
      wrapper.innerHTML = '<span class="CatanName"><span class="catanLocation" data-lat="' + portal.lat + '" data-lng="' + portal.lng + '">' + name + '</span></span>' +
        '<span><a>' + 'Remove' + '</a></span>';
      div.appendChild(wrapper);
    });
    const container = dialog({
      id: 'missingPortals',
      html: div,
      width: '420px',
      title: 'These portals are missing in Ingress',
      buttons: {
      }
    });

    // Update location
    container.on('click', 'a', function (e) {
      const row = this.parentNode.parentNode;
      const guid = row.getAttribute('data-guid');
      const catanData = thisPlugin.findByGuid(guid);
      const existingType = catanData.type;

      // remove marker
      removeCatanObject(existingType, guid);
      thisPlugin.saveStorage();

      $(row).fadeOut(200);

      delete missingPortals[guid];
      updateMissingPortalsCount();

      if (Object.keys(missingPortals).length == 0) {
        container.dialog('close');
      }
    });
    container.on('click', '.catanLocation', centerPortalAlt);
    configureHoverMarkerAlt(container);
  }

  function configureHoverMarker(container) {
    let hoverMarker;
    container.find('img.photo, .ingressLocation').hover(
      function hIn() {
        const row = this.parentNode.parentNode;
        const guid = row.getAttribute('data-guid');
        const portal = row.dataPortal || window.portals[guid];
        if (!portal)
          return;
        const center = portal._latlng || new L.LatLng(portal.lat, portal.lng);
        hoverMarker = L.marker(center, {
          icon: L.divIcon({
            className: 'Catan-PortalAnimationHover',
            iconSize: [40, 40],
            iconAnchor: [20, 20],
            html: ''
          }),
          interactive: false
        });
        map.addLayer(hoverMarker);
      }, function hOut() {
        if (hoverMarker)
          map.removeLayer(hoverMarker);
      });
  }

  function configureHoverMarkerAlt(container) {
    let hoverMarker;
    container.find('.catanLocation').hover(
      function hIn() {
        const lat = this.getAttribute('data-lat');
        const lng = this.getAttribute('data-lng');
        const center = new L.LatLng(lat, lng);
        hoverMarker = L.marker(center, {
          icon: L.divIcon({
            className: 'Catan-PortalAnimationHover',
            iconSize: [40, 40],
            iconAnchor: [20, 20],
            html: ''
          }),
          interactive: false
        });
        map.addLayer(hoverMarker);
      }, function hOut() {
        if (hoverMarker)
          map.removeLayer(hoverMarker);
      });
  }

  /**
   * Center the map on the clicked portal to help tracking it (the user will have to manually move the dialog)
   */
  function centerPortal(e) {
    const row = this.parentNode.parentNode;
    const guid = row.getAttribute('data-guid');
    const portal = row.dataPortal || window.portals[guid];
    if (!portal)
      return;
    const center = portal._latlng || new L.LatLng(portal.lat, portal.lng);
    map.panTo(center);
    drawClickAnimation(center);
  }

  function centerPortalAlt(e) {
    const lat = this.getAttribute('data-lat');
    const lng = this.getAttribute('data-lng');
    const center = new L.LatLng(lat, lng);
    map.panTo(center);
    drawClickAnimation(center);
  }

  function drawClickAnimation(center) {
    const marker = L.marker(center, {
      icon: L.divIcon({
        className: 'Catan-PortalAnimation',
        iconSize: [30, 30],
        iconAnchor: [15, 15],
        html: ''
      }),
      interactive: false
    });
    map.addLayer(marker);

    setTimeout(function () {
      map.removeLayer(marker);
    }, 2000);
  }

  function getPortalSummaryFromGuid(guid) {
    const newPortal = newPortals[guid];
    if (newPortal)
      return newPortal;

    const portal = window.portals[guid];
    if (!portal)
      return {};

    return {
      guid: guid,
      name: portal.options.data.title,
      lat: portal._latlng.lat,
      lng: portal._latlng.lng,
      image: portal.options.data.image,
      cells: {}
    };
  }

  function getPortalImage(poi) {
    if (poi.image)
      return '<img src="' + poi.image.replace('http:', 'https:') + '" class="photo">';

    const portal = window.portals[poi.guid];
    if (!portal)
      return '';

    if (portal && portal.options && portal.options.data && portal.options.data.image) {
      poi.image = portal.options.data.image;
      return '<img src="' + poi.image.replace('http:', 'https:') + '" class="photo">';
    }
    return '';
  }

  function getPortalName(poi) {
    if (poi.name)
      return poi.name;

    const portal = window.portals[poi.guid];
    if (!portal)
      return '';

    if (portal && portal.options && portal.options.data && portal.options.data.title) {
      poi.name = portal.options.data.title;
      return poi.name;
    }
    return '';
  }


  function removeLayer(name) {
    const layers = window.layerChooser._layers;
    const layersIds = Object.keys(layers);

    let layerId = null;
    let leafletLayer;
    let isBase;
    let arrayIdx;
    layersIds.forEach(id => {
      const layer = layers[id];
      if (layer.name == name) {
        leafletLayer = layer.layer;
        layerId = leafletLayer._leaflet_id;
        isBase = !layer.overlay;
        arrayIdx = id;
      }
    });

    // The Beacons and Frackers are not there in Firefox, why????
    if (!leafletLayer) {
      return;
    }

    const enabled = map._layers[layerId] != null;
    if (enabled) {
      // Don't remove base layer if it's used
      if (isBase)
        return;

      map.removeLayer(leafletLayer);
    }
    if (typeof leafletLayer.off != 'undefined')
      leafletLayer.off();

    // new Leaflet
    if (Array.isArray(layers)) {
      // remove from array
      layers.splice(parseInt(arrayIdx, 10), 1);
    } else {
      // classic IITC, leaflet 0.7.7
      // delete from object
      delete layers[layerId];
    }
    window.layerChooser._update();
    removedLayers[name] = {
      layer: leafletLayer,
      enabled: enabled,
      isBase: isBase
    };
    window.updateDisplayedLayerGroup(name, enabled);
  }
  const removedLayers = {};
  let portalsLayerGroup;

  function removeIngressLayers() {
    removeLayer('CartoDB Dark Matter');
    removeLayer('CartoDB Positron');
    removeLayer('Google Default Ingress Map');

    removeLayer('Fields');
    removeLayer('Links');
    removeLayer('DEBUG Data Tiles');
    removeLayer('Artifacts');
    removeLayer('Ornaments');
    removeLayer('Beacons');
    removeLayer('Frackers');

    removeLayer('Unclaimed/Placeholder Portals');
    for (let i = 1; i <= 8; i++) {
      removeLayer('Level ' + i + ' Portals');
    }
    //removeLayer('Resistance');
    //removeLayer('Enlightened');
    mergePortalLayers();
  }

  /**
   * Put all the layers for Ingress portals under a single one
   */
  function mergePortalLayers() {
    portalsLayerGroup = new L.LayerGroup();
    window.addLayerGroup('Ingress Portals', portalsLayerGroup, true);
    portalsLayerGroup.addLayer(removedLayers['Unclaimed/Placeholder Portals'].layer);
    for (let i = 1; i <= 8; i++) {
      portalsLayerGroup.addLayer(removedLayers['Level ' + i + ' Portals'].layer);
    }
  }

  /**
   * Remove the single layer for all the portals
   */
  function revertPortalLayers() {
    if (!portalsLayerGroup) {
      return;
    }
    const name = 'Ingress Portals';
    const layerId = portalsLayerGroup._leaflet_id;
    const enabled = map._layers[layerId] != null;

    const layers = window.layerChooser._layers;
    if (Array.isArray(layers)) {
      // remove from array
      const idx = layers.findIndex(o => o.layer._leaflet_id == layerId);
      layers.splice(idx, 1);
    } else {
      // classic IITC, leaflet 0.7.7
      // delete from object
      delete layers[layerId];
    }
    window.layerChooser._update();
    window.updateDisplayedLayerGroup(name, enabled);

    if (typeof portalsLayerGroup.off != 'undefined')
      portalsLayerGroup.off();
    if (enabled) {
      map.removeLayer(portalsLayerGroup);
    }
    portalsLayerGroup = null;
  }

  function restoreIngressLayers() {
    revertPortalLayers();

    Object.keys(removedLayers).forEach(name => {
      const info = removedLayers[name];
      if (info.isBase)
        window.layerChooser.addBaseLayer(info.layer, name);
      else
        window.addLayerGroup(name, info.layer, info.enabled);
    });
  }

  function zoomListener() {
    const zoom = map.getZoom();
    document.body.classList.toggle('smallresources', zoom < 16);
  }

  const setup = function () {
    thisPlugin.isSmart = window.isSmartphone();

    initSvgIcon();

    loadSettings();

    // Load data from localStorage
    thisPlugin.loadStorage();

    thisPlugin.htmlStar = `<a class="catanSettlement" accesskey="m" onclick="window.plugin.catan.switchStarPortal('settlements');return false;" title="Mark this portal as a settlement [m]"><span></span></a>
      <a class="catanResource" accesskey="c" onclick="window.plugin.catan.switchStarPortal('resources');return false;" title="Mark this portal as a resource [c]"><span></span></a>
      <a class="notCatan" onclick="window.plugin.catan.switchStarPortal('notcatan');return false;" title="Mark this portal as a removed/Not Available in Catan"><span></span></a>
      `;

    thisPlugin.setupCSS();

    const sidebarCatan = document.createElement('div');
    sidebarCatan.id = 'sidebarCatan';
    sidebarCatan.style.display = 'none';
    if (thisPlugin.isSmart) {
      const status = document.getElementById('updatestatus');
      sidebarCatan.classList.add('mobile');
      status.insertBefore(sidebarCatan, status.firstElementChild);

      const dStatus = document.createElement('div');
      dStatus.className = 'CatanStatus';
      status.insertBefore(dStatus, status.firstElementChild);
    } else {
      document.getElementById('sidebar').appendChild(sidebarCatan);
    }

    sidebarCatan.appendChild(createCounter('Review required', 'classification', promptToClassifyPois));
    sidebarCatan.appendChild(createCounter('Moved portals', 'moved', promptToMovePois));
    sidebarCatan.appendChild(createCounter('Missing portals', 'missing', promptToRemovePois));

    window.addHook('portalSelected', thisPlugin.onPortalSelected);

    window.addHook('portalAdded', onPortalAdded);
    window.addHook('mapDataRefreshStart', function () {
      sidebarCatan.classList.add('refreshingData');
    });
    window.addHook('mapDataRefreshEnd', function () {
      sidebarCatan.classList.remove('refreshingData');
      refreshNewPortalsCounter();
    });
    map.on('moveend', function () {
      refreshNewPortalsCounter();
    });
    sidebarCatan.classList.add('refreshingData');

    // Layer - Catan portals
    settlementLayerGroup = new L.LayerGroup();
    window.addLayerGroup('Settlements', settlementLayerGroup, true);
    resourceLayerGroup = new L.LayerGroup();
    window.addLayerGroup('Resources', resourceLayerGroup, true);
    notCatanLayerGroup = new L.LayerGroup();
    window.addLayerGroup('N/A', notCatanLayerGroup, false);
    regionLayer = L.layerGroup();
    window.addLayerGroup('S2 Grid', regionLayer, true);

    // this layer will group all the nearby circles that are added or removed from it when the portals are added or removed
    nearbyGroupLayer = L.layerGroup();

    thisPlugin.addAllMarkers();

    const toolbox = document.getElementById('toolbox');

    const buttonCatan = document.createElement('a');
    buttonCatan.textContent = 'Catan Actions';
    buttonCatan.title = 'Actions on Catan data';
    buttonCatan.addEventListener('click', thisPlugin.catanActionsDialog);
    toolbox.appendChild(buttonCatan);

    const buttonGrid = document.createElement('a');
    buttonGrid.textContent = 'Catan Settings';
    buttonGrid.title = 'Settings for S2 & Catan';
    buttonGrid.addEventListener('click', e => {
      if (thisPlugin.isSmart)
        window.show('map');
      showS2Dialog();
    });
    toolbox.appendChild(buttonGrid);

    map.on('zoomend', zoomListener);
    zoomListener();
    map.on('moveend', updateMapGrid);
    updateMapGrid();

    // add ids to the links that we want to be able to hide
    const links = document.querySelectorAll('#toolbox > a');
    links.forEach(a => {
      const text = a.textContent;
      if (text == 'Region scores') {
        a.id = 'scoresLink';
      }
      if (text == 'Artifacts') {
        a.id = 'artifactLink';
      }
    });

  };

  function createCounter(title, type, callback) {
    const div = document.createElement('div');
    div.style.display = 'none';
    const sTitle = document.createElement('span');
    sTitle.textContent = title;
    const counter = document.createElement('a');
    counter.id = 'CatanCounter-' + type;
    counter.addEventListener('click', function (e) {
      callback(counter.CatanData);
      return false;
    });
    div.appendChild(sTitle);
    div.appendChild(counter);
    return div;
  }

  function updateCounter(type, data) {
    const counter = document.querySelector('#CatanCounter-' + type);
    counter.CatanData = data;
    counter.textContent = data.length;
    counter.parentNode.style.display = data.length > 0 ? '' : 'none';

    // Adjust visibility of the pane to avoid the small gap due to padding
    const pane = counter.parentNode.parentNode;
    if (data.length > 0) {
      pane.style.display = '';
      return;
    }
    let node = pane.firstElementChild;
    while (node) {
      const rowData = node.lastElementChild.CatanData;
      if (rowData && rowData.length > 0) {
        pane.style.display = '';
        return;
      }
      node = node.nextElementSibling;
    }
    pane.style.display = 'none';
  }

  // PLUGIN END //////////////////////////////////////////////////////////

  setup.info = plugin_info; //add the script info data to the function as a property
  // if IITC has already booted, immediately run the 'setup' function
  if (window.iitcLoaded) {
    setup();
  } else {
    if (!window.bootPlugins) {
      window.bootPlugins = [];
    }
    window.bootPlugins.push(setup);
  }
}


(function () {
  const plugin_info = {};
  if (typeof GM_info !== 'undefined' && GM_info && GM_info.script) {
    plugin_info.script = {
      version: GM_info.script.version,
      name: GM_info.script.name,
      description: GM_info.script.description
    };
  }

  // Greasemonkey. It will be quite hard to debug
  if (typeof unsafeWindow != 'undefined' || typeof GM_info == 'undefined' || GM_info.scriptHandler != 'Tampermonkey') {
    // inject code into site context
    const script = document.createElement('script');
    script.appendChild(document.createTextNode('(' + wrapperS2 + ')();'));
    script.appendChild(document.createTextNode('(' + wrapperPlugin + ')(' + JSON.stringify(plugin_info) + ');'));
    (document.body || document.head || document.documentElement).appendChild(script);
  } else {
    // Tampermonkey, run code directly
    wrapperS2();
    wrapperPlugin(plugin_info);
  }
})();
