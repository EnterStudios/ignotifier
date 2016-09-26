'use strict';

var {Cc, Ci, Cu}  = require('chrome'),
    {on, off, once, emit} = require('sdk/event/core'),
    {ToggleButton} = require('sdk/ui/button/toggle'),
    tabs = require('sdk/tabs'),
    self = require('sdk/self'),
    loader = require('@loader/options'),
    array = require('sdk/util/array'),
    data = self.data,
    panel = require('sdk/panel'),
    l10n = require('sdk/l10n').get,
    timer = require('sdk/timers'),
    pageWorker = require('sdk/page-worker'),
    pageMod = require('sdk/page-mod'),
    sp = require('sdk/simple-prefs'),
    prefs = sp.prefs,
    unload = require('sdk/system/unload'),
    events = require('sdk/system/events'),
    config = require('../../config'),
    tbExtra = require('./tbExtra'),
    windows = {
      utils: require('sdk/window/utils'),
      get active () { // Chrome window
        return this.utils.getMostRecentBrowserWindow();
      },
      get SDKWindow () { // SDK window
        return require('sdk/windows').browserWindows.activeWindow;
      },
    };

var exportsHelper = {};

var {Promise} = Cu.import('resource://gre/modules/Promise.jsm');
var {XPCOMUtils} = Cu.import('resource://gre/modules/XPCOMUtils.jsm');

// Event Emitter
exports.on = on.bind(null, exports);
exports.once = once.bind(null, exports);
exports.emit = emit.bind(null, exports);
exports.removeListener = (type, listener) => off(exports, type, listener);

/* button */
var buttonDetached = false;
var button = new ToggleButton({
  id: self.name,
  label: l10n('toolbar_label'),
  icon: {
    '16': './icons/blue/16.png',
    '32': './icons/blue/32.png'
  },
  onChange: function (state) {
    if (button.onClick && state.checked) {
      button.onClick();
    }
    button.state('window', {
      checked: !buttonDetached
    });
  }
});

/* popup */
var popup = panel.Panel({
  contentURL: data.url('./popup/index.html'),
  contentScriptFile: [
    data.url('./popup/firefox/firefox.js'),
    data.url('./popup/index.js')
  ],
  contentScriptOptions: {
    base: loader.prefixURI,
    locales: {
      'popup_wait': l10n('popup_wait'),
      'popup_read': l10n('popup_read'),
      'popup_date_format': l10n('popup_date_format'),
      'popup_msg_3_format': l10n('popup_msg_3_format'),
      'popup_msg_7_format': l10n('popup_msg_7_format'),
      'popup_msg_8_format': l10n('popup_msg_8_format'),
      'popup_msg_9_format': l10n('popup_msg_9_format'),
      'popup_msg_1': l10n('popup_msg_1'),
      'popup_msg_2': l10n('popup_msg_2'),
      'popup_msg_3': l10n('popup_msg_3'),
      'popup_msg_4': l10n('popup_msg_4'),
      'popup_msg_5': l10n('popup_msg_5'),
      'popup_msg_6': l10n('popup_msg_6'),
      'popup_msg_7': l10n('popup_msg_7'),
      'popup_msg_8': l10n('popup_msg_8'),
      'popup_msg_9': l10n('popup_msg_9'),
      'popup_msg_10': l10n('popup_msg_10'),
      'popup_msg_11': l10n('popup_msg_11'),
      'popup_msg_12': l10n('popup_msg_12'),
      'popup_msg_13': l10n('popup_msg_13'),
      'popup_msg_14': l10n('popup_msg_14'),
      'popup_msg_15': l10n('popup_msg_15'),
      'popup_msg_16': l10n('popup_msg_16'),
      'popup_msg_17': l10n('popup_msg_17'),
      'popup_msg_18': l10n('popup_msg_18'),
      'popup_msg_19': l10n('popup_msg_19'),
      'popup_msg_20': l10n('popup_msg_20'),
      'popup_msg_21': l10n('popup_msg_21')
    }
  }
});
popup.on('show', () => popup.port.emit('show'));
popup.on('hide', () => {
  button.state('window', {
    checked: false
  });
});
/* option */
var options = (function () {
  var workers = [], options_arr = [];
  pageMod.PageMod({
    include: data.url('options/index.html'),
    contentScriptFile: [
      data.url('options/firefox/firefox.js'),
      data.url('options/index.js')
    ],
    contentScriptWhen: 'start',
    contentScriptOptions: {
      base: loader.prefixURI
    },
    onAttach: function(worker) {
      array.add(workers, worker);
      worker.on('pageshow', function() { array.add(workers, this); });
      worker.on('pagehide', function() { array.remove(workers, this); });
      worker.on('detach', function() { array.remove(workers, this); });
      // PageMod has no access to mozFullPath of input.
      worker.port.on('get-sound-fullpath', function () {
        var browserWindow = Cc['@mozilla.org/appshell/window-mediator;1'].
                        getService(Ci.nsIWindowMediator).
                        getMostRecentWindow('navigator:browser');
        var file = browserWindow.content.document.querySelector('input[type=file]').files[0].mozFullPath;
        config.notification.sound.custom.file = file;
      });
      options_arr.forEach(function (arr) {
        worker.port.on(arr[0], arr[1]);
      });
    }
  });
  return {
    send: function (id, data) {
      workers.forEach(function (worker) {
        worker.port.emit(id, data);
      });
    },
    receive: (id, callback) => options_arr.push([id, callback])
  };
})();

function get (url, headers, data, timeout) {
  headers = headers || {};

  var d = new Promise.defer();
  var req = Cc['@mozilla.org/xmlextras/xmlhttprequest;1']
    .createInstance(Ci.nsIXMLHttpRequest);
  req.mozBackgroundRequest = true;  //No authentication
  req.timeout = timeout;
  req.open('GET', url, true);
  for (var id in headers) {
    req.setRequestHeader(id, headers[id]);
  }
  req.onreadystatechange = function () {
    if (req.readyState === 4) {
      d.resolve(req);
    }
  };
  req.channel
    .QueryInterface(Ci.nsIHttpChannelInternal)
    .forceAllowThirdPartyCookie = true;
  if (data) {
    var arr = [];
    for (let e in data) {
      arr.push(e + '=' + data[e]);
    }
    data = arr.join('&');
  }
  req.send(data ? data : '');
  return d.promise;
}

/* exports */
exports.Promise = Promise;

exports.button = {
  onCommand: function (c) {
    button.onClick = c;
  },
  onContext: function (c) {
    tbExtra.onContext(function (e, menupopup, menuitem, menuseparator, menu) {
      let types = {
        'menupopup': menupopup,
        'menuitem': menuitem,
        'menuseparator': menuseparator,
        'menu': menu
      };
      // remove old items
      while (menupopup.firstChild) {
        menupopup.removeChild(menupopup.firstChild);
      }
      var items = c();
      function appendChilds (root, arr) {
        arr.forEach(function (e) {
          var element = types[e.type].cloneNode(false);
          ['label', 'tooltip', 'value', 'link'].filter(function (i) {
            return e[i];
          }).forEach(function (i) {
            return element.setAttribute(i, e[i]);
          });
          if (e.command) {
            element.addEventListener('command', function (event) {
              event.preventDefault();
              event.stopPropagation();
              e.command(event);
            }, false);
          }
          root.appendChild (element);
          if (e.childs && e.childs.length) {
            appendChilds(element, e.childs);
          }
        });
      }
      appendChilds(menupopup, items);
    });
  },
  onClick: function (c) {
    tbExtra.onClick(c);
  },
  set label (val) { //jshint ignore:line
    button.label = config.ui.tooltip ? l10n('toolbar_label') : val;
  },
  set badge (val) { //jshint ignore:line
    if (config.ui.badge) {
      button.badge = val ? val : '';
      button.badgeColor = config.ui.backgroundColor;
    }
  },
  set color (val) { //jshint ignore:line
    button.icon = {
      '16': './icons/' + val + '/16.png',
      '32': './icons/' + val + '/32.png'
    };
  }
};

exports.popup = {
  show: function () {
    buttonDetached = false;
    popup.show({
      width: config.popup.width,
      height: config.popup.height,
      position: button
    });
  },
  hide: () => popup.hide(),
  attach: function () {},
  detach: () => {
    buttonDetached = true;
    popup.hide();
  },
  send: function (id, data) {
    if (id === 'resize') {
      popup.resize(data.width, data.height);
    }
    if (popup.isShowing) {
      popup.port.emit(id, data);
    }
  },
  receive: (id, callback) => popup.port.on(id, callback)
};

exports.timer = timer;

exports.get = get;

exports.parser = function () {
  return Cc['@mozilla.org/xmlextras/domparser;1']
    .createInstance(Ci.nsIDOMParser);
};

exports.l10n = (id) => l10n(id);

exports.windows = (function () {
  function toWindow (win) {
    return {
      obj: win,
      focus: function () {
        try {
          (win.focus || win.activate)();
        }
        catch (e) {}
      }
    };
  }
  function toTab (tab) {
    return {
      get url () {
        return tab.url;
      },
      set url (val) {
        if (tab.url === val) {
          tab.reload();
        }
        else {
          tab.url = val;
        }
      },
      activate: () => tab.activate(),
      window: () => Promise.resolve(toWindow(toWindow(tab.window))),
      get active () {
        return tab === tabs.activeTab;
      },
      close: function () {
        tab.close();
      }
    };
  }
  return {
    active: function () {
      return Promise.resolve(toWindow(windows.active));
    },
    open: function (url, inBackground) {
      var popup = windows.active.open(url);
      if (inBackground) {
        popup.blur();
        window.focus();
      }
    },
    tabs: {
      list: function (currentWindow) {
        var tbs = currentWindow ? windows.SDKWindow.tabs : tabs;
        var temp = [];
        for each (var tab in tbs) {
          temp.push(tab);
        }
        return Promise.resolve(temp.map(toTab));
      },
      active: function () {
        return Promise.resolve(toTab(tabs.activeTab));
      },
      open: function (url, inBackground) {
        var gBrowser = windows.active.gBrowser;
        // use old blank tabs?
        (function () {
          if (config.tabs.open.relatedToCurrent || !config.tabs.open.useBlankTabs) {
            return Promise.resolve(null);
          }
          return exports.windows.tabs.list(true).then(function (tabs) {
            return tabs.reduce(function (p, c) {
              return p || (c.url === 'about:newtab' || c.url === 'about:blank' ? c : null);
            }, null);
          });
        })().then(function (t) {
          if (t) {
            t.url = url;
            if (!inBackground) {
              t.activate();
            }
          }
          else {
            t = gBrowser.addTab(url, {
              relatedToCurrent: config.tabs.open.relatedToCurrent
            });
            if (!inBackground) {
              gBrowser.selectedTab = t;
            }
          }
        });
      }
    }
  };
})();

exports.notify = (function () {
  let stack = [], wait = false, notifications;
  function doOne () {
    if (wait) {
      return;
    }
    if (stack.length === 0) {
      return;
    }
    wait = true;
    let obj = stack.shift();
    notifications = notifications || require('sdk/notifications');
    notifications.notify({
      title: obj.title || l10n('gmail'),
      text: obj.text,
      onClick: obj.onClick,
      iconURL: data.url('./icons/red/128.png')
    });
    timer.setTimeout(function () {
      wait = false;
      doOne();
    }, 4000);
  }
  return function (text, title, onClick) {
    if (config.notification.silent) {
      return;
    }
    stack.push({text, title, onClick});
    if (!wait) {
      doOne();
    }
  };
})();

XPCOMUtils.defineLazyGetter(exportsHelper, 'play', function () {
  let {FileUtils} = Cu.import('resource://gre/modules/FileUtils.jsm');
  let {Services} = Cu.import('resource://gre/modules/Services.jsm');

  return {
    now: function () {
      if (config.notification.silent) {
        return;
      }

      var path = '../../data/sounds/' + config.notification.sound.original;
      if (config.notification.sound.type === 4 && config.notification.sound.custom.file) {
        var file = new FileUtils.File(config.notification.sound.custom.file);
        if (file.exists()) {
          path = Services.io.newFileURI(file).spec;
          let res = Services.io.getProtocolHandler('resource').QueryInterface(Ci.nsIResProtocolHandler);
          let name = 'igsound';
          res.setSubstitution(name, Services.io.newURI(path, null, null));
          path = 'resource://' + name;
        }
      }
      var worker = pageWorker.Page({
        contentScript:
          "var audio = new Audio('" + path + "');" +
          "audio.addEventListener('ended', function () {self.postMessage()});" +
          "audio.volume = " + (config.notification.sound.volume / 100) + ";" +
          "audio.play();",
        contentURL: data.url("firefox/sound.html"),
        onMessage: function() {
          worker.destroy();
        }
      });
    },
    reset: function () {}
  };
});
Object.defineProperty(exports, 'play', {
  get: function () {
    return exportsHelper.play;
  }
});

XPCOMUtils.defineLazyGetter(exportsHelper, 'clipboard', function () {
  var clipboardHelper = Cc['@mozilla.org/widget/clipboardhelper;1']
    .getService(Ci.nsIClipboardHelper);
  return function (str) {
    clipboardHelper.copyString(str);
  };
});
Object.defineProperty(exports, 'clipboard', {
  get: function () {
    return exportsHelper.clipboard;
  }
});

exports.version = () => self.version;

exports.startup = function (c) {
  if (self.loadReason === 'startup' || self.loadReason === 'install') {
    c();
  }
};

exports.unload = (c) => unload.when(c);

exports.options = options;

exports.storage = {
  read: function (id) {
    return (prefs[id] || prefs[id] + '' === 'false' || !isNaN(prefs[id])) ? (prefs[id] + '') : null;
  },
  write: function (id, data) {
    data = data + '';
    if (data === 'true' || data === 'false') {
      prefs[id] = data === 'true' ? true : false;
    }
    else if (parseInt(data) + '' === data) {
      prefs[id] = parseInt(data);
    }
    else {
      prefs[id] = data + '';
    }
  }
};

exports.manifest = {
  url: loader.prefixURI
};

exports.tray = require('./tray/wrapper').tray;

/* updating badge when action is posted */
function listener(event) {
  var channel = event.subject.QueryInterface(Ci.nsIHttpChannel);
  var url = channel.URI.spec;
  if (url.indexOf('https://mail.google.com/mail/u') === -1 || url.indexOf('act=') === -1) {
    return;
  }
  channel = channel.QueryInterface(Ci.nsIHttpChannel);
  exports.emit('update');
}
events.on('http-on-modify-request', listener);

// connect
exports.connect = function (actions) {
  var connect = {};
  Cu.import(data.url('firefox/shared/connect.jsm'), connect);
  connect.remote.actions = actions;
  Object.freeze(connect);
};
