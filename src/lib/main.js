/** Require **/
var tabs             = require("tabs"),
    self             = require("self"),
    timer            = require("timers"),
    notifications    = require("notifications"),
    toolbarbutton    = require("toolbarbutton"),
    window           = require("window-utils").activeBrowserWindow,
    prefs            = require("simple-prefs").prefs,
    _                = require("l10n").get,
    data             = self.data,
    {Cc, Ci, Cu}     = require('chrome'),
    {XMLHttpRequest} = require("xhr");

/** Internal configurations **/
var config = {
  //Gmail
  email: {
    url: "https://mail.google.com/mail/u/0",
    get feeds() {
      const FEEDS = "https://mail.google.com/mail/u/0/feed/atom," + 
        "https://mail.google.com/mail/u/1/feed/atom," + 
        "https://mail.google.com/mail/u/2/feed/atom," + 
        "https://mail.google.com/mail/u/3/feed/atom";
      //server only supports atom feeds
      var temp = (prefs.feeds.replace(/rss20/g, "atom10") || FEEDS).split(",");
      //Check Feed formats
      temp.forEach(function (feed, index) {
        temp[index] = feed.replace(/^\s\s*/, '').replace(/\s\s*$/, '')
      });
      return temp;
    }
  },
  //Timing
  get period () {return (prefs.period > 10 ? prefs.period : 10)},
  firstTime: 1,
  //Toolbar
  image: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAKCAIAAAAy3EnLA" +
    "AAABGdBTUEAALGPC/xhBQAAAAlwSFlzAAAOwQAADsEBuJFr7QAAABp0RVh0U29mdHdhcmUAU" +
    "GFpbnQuTkVUIHYzLjUuMTAw9HKhAAAAgklEQVQoU22QsRWAIAxE2YpZ3IZp2CDDWKaztbPie" +
    "XAQQcKjQPN/LhDOGLnvlJ6c3Y2SYcFOOBSRsi+RmekCelzH4TiNRslCuoC+jjPRAJjzCX9np" +
    "X0Bd7Acm8QutiWo4onM4dz4rD9VtwTSrcDZKs01SkvCTDsv25x1pNHboUcOhRfmUFFAGpPmb" +
    "QAAAABJRU5ErkJggg==",
  get textColor () {return prefs.textColor || "#000"},
  get backgroundColor () {return prefs.backgroundColor || "#FFB"},
  move: {toolbarID: "nav-bar", forceMove: false},
  //Debug
  debug: false
};

/** Initialize **/
var gButton, unreadObjs = [];
exports.main = function(options, callbacks) {
  //Gmail button
  gButton = toolbarbutton.ToolbarButton({
    id: "igmail-notifier",
    label: _("gmail"),
    tooltiptext: _("gmail") + "\n\n" + _("tooltip1") + "\n" + _("tooltip2"),
    image: data.url("gmail[U].png"),
    onClick: function (e) {
      if (e.button == 1 || e.button == 2) {
        checkAllMails(true);
        e.preventDefault();
      }
    },
    onCommand: function () {
      if (!unreadObjs.length) {
        tabs.open({url: config.email.url, inBackground: false});
      }
      else if (unreadObjs.length == 1) {
        tabs.open({url: unreadObjs[0].link, inBackground: false});
      }
      else {
        var items = [];
        unreadObjs.forEach(function (obj){items.push(obj.account)});
        var rtn = prompts(_("msg4"), _("msg5"), items);
        if (rtn[0]) {
          tabs.open({url: unreadObjs[rtn[1]].link, inBackground: false});
        }
      }
    }
  });
  //Timer
  timer.setInterval(function () {
    checkAllMails();
  }, config.period * 1000);
  timer.setTimeout(function () {
    checkAllMails();
  }, config.firstTime * 1000);
  //Install
  if (options.loadReason == "install") {
    gButton.moveTo(config.move);
  }
};

/** Server **/
var server = {
  parse: function (req) {
    var xml;
    if (req.responseXML) {
      xml = req.responseXML;
    }
    else {
      if (!req.responseText) return;
      
      var parser = Cc["@mozilla.org/xmlextras/domparser;1"]
        .createInstance(Ci.nsIDOMParser);
      xml = parser.parseFromString(req.responseText, "text/xml");
    }
    return {
      get fullcount () {
        var temp = 0;
        try {
          var tags = xml.getElementsByTagName("fullcount");
          if (tags.length) {
            temp = parseInt(tags[0].childNodes[0].nodeValue);
          }
          else { //atom does not provide fullcount attribute
            temp = xml.getElementsByTagName("entry").length;
          }
        } catch(e){}
        return temp;
      },
      get title () {
        var temp = "";
        try {
          temp = xml.getElementsByTagName("title")[0].childNodes[0].nodeValue;
          temp = temp.match(/[^ ]+@.+\.[^ ]+/)[0];
        } catch(e) {}
        return temp;
      },
      get link () {
        var temp = "https://mail.google.com/mail/u/0/";
        try {
          temp = xml.getElementsByTagName("link")[0].getAttribute("href")
        } catch(e) {}
        return temp;
      },
      get authorized () {
        var temp = "";
        try {
          temp = xml.getElementsByTagName("TITLE")[0].childNodes[0].nodeValue;
        } catch(e){}
        return temp;
      },
      get enteries () {
        return Array.prototype.slice.call( xml.getElementsByTagName("entry") ) 
      }
    }
  },
  /* check gmail
   * feed: feed url
   * callback: callback function [xml, count, color, [title, text]]
   * pointer: callback this pointer
   */
  mCheck: function (feed, callback, pointer) {
    var state = false,
        msgs = [];
    /*
     * forced: is this a forced check?
     * isRecent: did user recently receive a notification?
     */
    return function (forced, isRecent) {
      //Check state
      if (state && !forced) { 
        debug("[Warning] Gmail notifier listening at " + feed + " is busy right now. Try it later, or try the force option.");
        return;
      }
      if (state && forced) {
        debug("[Warning] Gmail notifier was busy. But this is a forced command.");
      }
      //Initialazing
      state = true;
      var req = new XMLHttpRequest();
      req.open('GET', feed, true);
      req.onreadystatechange = function () {
        if (req.readyState != 4) return;
        var xml = new server.parse(req);
        
        var count = 0;
        var normal = false; //not logged-in but normal response from gmail
        var newUnread = false;
        var exist = req.status == 200;  //Gmail account is loged-in
        if (exist) {
          count = xml.fullcount;
          xml.enteries.forEach(function (entry, i) {
            var id = entry.getElementsByTagName("id")[0].childNodes[0].nodeValue;
            if (msgs.indexOf(id) == -1) {
              newUnread = true;
            }
          });
          msgs = [];
          xml.enteries.forEach(function (entry, i) {
            msgs.push(entry.getElementsByTagName("id")[0].childNodes[0].nodeValue);
          });
        }
        else {
          msgs = [];
        }

        if (!exist && req.responseText && xml.authorized == "Unauthorized") {
          normal = true;
        }
        state = false;
        
        debug("Gmail Notifier: exist:" + exist + " count:" + count + " normal:" + normal + " newUnread:" + newUnread);
        //Gmail logged-in && has count && new count && forced
        if (exist && count && newUnread && forced) {
                                              /* xml, count, showAlert, color, message */
          if (callback) callback.apply(pointer, [xml, count, true, "red", [xml.title, count]])
          return;
        }
        //Gmail logged-in && has count && new count && no force
        if (exist && count && newUnread && !forced) {
          if (callback) callback.apply(pointer, [xml, count, true, "red", [xml.title, count]])
          return;
        }
        //Gmail logged-in && has count && old count && forced
        if (exist && count && !newUnread && forced) {
          if (callback) callback.apply(pointer, [xml, count, true, "red", [xml.title, count]])
          return;
        }
        //Gmail logged-in && has count && old count && no forces
        if (exist && count && !newUnread && !forced) {
          if (callback) callback.apply(pointer, [xml, count, false, "red", [xml.title, count]])
          return;
        }
        //Gmail logged-in && has no-count && new count && forced
        if (exist && !count && newUnread && forced) {
          if (callback) callback.apply(pointer, [xml, 0, false, "gray"])
          return;
        }
        //Gmail logged-in && has no-count && new count && no force
        if (exist && !count && !newUnread && !forced) {
          if (callback) callback.apply(pointer, [xml, 0, false, "gray"])
          return;
        }
        //Gmail logged-in && has no-count && old count && forced
        if (exist && !count && !newUnread && forced) {
          if (callback) callback.apply(pointer, [xml, 0, false, "gray"])
          return;
        }
        //Gmail logged-in && has no-count && old count && no forced
        if (exist && !count && !newUnread && !forced) {
          if (callback) callback.apply(pointer, [xml, 0, false, "gray"])
          return;
        }
        //Gmail not logged-in && no error && forced
        if (!exist && normal && forced) {
          if (!isRecent) tabs.open(config.email.url);
          
          if (callback) callback.apply(pointer, [xml, null, false, "unknown", 
            isRecent ? null : ["", _("msg1")]]);
          return;
        }
        //Gmail not logged-in && no error && no force
        if (!exist && normal && !forced) {
          if (callback) callback.apply(pointer, [xml, null, false, "unknown"])
          return;
        }
        //Gmail not logged-in && error && forced
        if (!exist && !normal && forced) {
          if (callback) callback.apply(pointer, [xml, null, false, "unknown", 
          isRecent ? null : [_("error"), _("msg2")]]);
          return;
        }
        //Gmail not logged-in && error && no force
        if (!exist && !normal && !forced) {
          if (callback) callback.apply(pointer, [xml, null, false, "unknown"])
          return;
        }
      }
      req.send(null);
    }
  }
}

/** checkAllMails **/
var checkAllMails = (function () {
  var len = config.email.feeds.length,
      pushCount,
      isForced,
      results = [],
      gClients = [];
  config.email.feeds.forEach(function (feed, index) {
    gClients[index] = new server.mCheck(feed, step1);
  });
  
  function step1(xml, count, alert, color, msgObj) {
    results.push({xml: xml, count: count, alert: alert, color: color, msgObj: msgObj});
    
    pushCount -= 1;
    if (!pushCount) step2();
  }
  function step2 () {
    //clear old feeds
    unreadObjs = [];
    //Notifications
    var text = "", tooltiptext = "", total = 0;
    var showAlert = isForced;
    results.forEach(function (r, i) {
      if (r.msgObj) {
        if (typeof(r.msgObj[1]) == "number") {
          if (r.alert) text += (text ? " - " : "") + r.msgObj[0] + " (" + r.msgObj[1] + ")";
          tooltiptext += (tooltiptext ? "\n" : "") + r.msgObj[0] + " (" + r.msgObj[1] + ")";
          total += r.msgObj[1];
          
          unreadObjs.push({link: r.xml.link, account: r.msgObj[0]});
        }
        else {
          text += (text ? " - " : "") + r.msgObj[0] + " " + r.msgObj[1];
        }
      }
      showAlert = showAlert || r.alert;
    });
    if (showAlert && text) {
      if (prefs.notification) notify(_("gmail"), text);
      if (prefs.alert) play();
    }
    unreadObjs.sort(function(a,b){return a.link > b.link})
    //Tooltiptext
    gButton.tooltiptext = tooltiptext ? tooltiptext : _("gmail") + "\n\n" + _("tooltip1") + "\n" + _("tooltip2");
    //Icon
    var isRed = false,
        isGray = false;
    results.forEach(function (r, i) {
      if (r.color == "red") isRed = true;
      if (r.color == "gray") isGray = true;
    });
    if (isRed) {
      var svg = 
        "<svg height='16' width='20' xmlns:xlink='http://www.w3.org/1999/xlink' xmlns='http://www.w3.org/2000/svg'>" +
          "<image x='0' y='3' height='10' width='16' xlink:href='" + config.image + "'></image>" +
          "<circle cx='15' cy='11' r='5' fill='" + config.backgroundColor + "'/>" +
          "<text x='15' y='14' font-size='10' text-anchor='middle' font-family='Courier' font-weight='bold' fill='" + config.textColor + "'>%d</text>" +
        "</svg>";
      gButton.image = "data:image/svg+xml;base64," + window.btoa(svg.replace("%d", total < 10 ? total : "+"));
    }
    else if (isGray) gButton.image = data.url("gmail[G].png");
    if (!isRed && !isGray) gButton.image = data.url("gmail[U].png");
  }

  return function (forced) {
    if (forced) gButton.image = data.url("load.png");
  
    pushCount = len;
    results = [];
    isForced = forced;
    gClients.forEach(function(gClient, index){gClient(forced, index ? true : false)});
  }
})();

/** Notifier **/
var notify = (function () {
  return function (title, text) {
    notifications.notify({
      title: title, 
      text: text,
      iconURL: data.url("notification.png")
    });
  }
})();

/** Player **/
var play = function () {
  var sound = Cc["@mozilla.org/sound;1"].createInstance(Ci.nsISound);
  sound.playEventSound(0);
}

/** Prompt **/
var prompts = (function () {
  var prompts = Cc["@mozilla.org/embedcomp/prompt-service;1"].getService(Ci.nsIPromptService);
  return function (title, content, items) {
    var selected = {};
    var result = prompts.select(null, title, content, items.length, items, selected);
    return [result, selected.value];
  }
})();

/** Debuger **/
var debug = function (text) {
  if (config.debug) {
    console.log(text);
  }
}
