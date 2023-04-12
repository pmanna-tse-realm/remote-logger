'use strict';

const Realm = require("realm");
const { ObjectId } = require('bson');

const LogEntrySchema = {
  name: 'LogEntry',
  asymmetric: true,
  properties: {
    _id: 'objectId',
    appId: 'string',
    logLevel: 'int',
    logSessionId: 'objectId',
    message: 'string',
    timestamp: 'date',
    userId: 'string?',
  },
  primaryKey: '_id',
};

class RemoteLogger {
  constructor(logAppId, APIKey, logLevel = 'off') {
    this.logAppId = logAppId;
    this.APIKey = APIKey;
    this.logApp = new Realm.App({ id: logAppId });
    this.entries = [];

    // We usually don't want to log much about ourselves
    // But just in case, ensure we're marking our own messages
    Realm.App.Sync.setLogLevel(this.logApp, logLevel);
    Realm.App.Sync.setLogger(this.logApp, (level, message) => console.log(`[${new Date()}] - RL - (${level}) ${message}`));
  }

  async openRealm(user) {
    const config = {
      schema: [LogEntrySchema],
      sync: {
        user: user,
        flexible: true,
        clientReset: { mode: Realm.ClientResetMode.RecoverUnsyncedChanges }
      },
    };

    return Realm.open(config);
  }

  expiredUser(user) {
    let token = user.refreshToken;
    let encodedPayload = token.split(".")[1];
    let payload = JSON.parse(Buffer.from(encodedPayload, 'base64'));
    let expiryDate = new Date(payload.exp * 1000);
    let now = new Date();

    return now >= expiryDate;
  }

  flushEntries() {
    this.realm.write(() => {
      this.entries.forEach(element => {
        this.realm.create("LogEntry", element);
      });
    });

    this.entries = [];
  }

  addLogEntry(level, message) {
    let user = this.hostApp.currentUser;
    let logEntry = {
      _id: new ObjectId(),
      appId: this.hostApp.id,
      logLevel: level,
      logSessionId: this.logSessionId,
      message: message,
      timestamp: new Date(),
    };

    if (user && user.isLoggedIn) {
      logEntry.userId = user.id;
    }

    this.entries.push(logEntry);

    // For performance purposes, we don't save each and every entry, but batch them in memory
    // Too low, and we add a lot of traffic, too high and we risk losing too many entries if app crashes
    if (this.entries.length >= this.entryBatch) {
      this.flushEntries();
    }
  }

  async startLogging(app, logLevel = "info", entryBatch = 5) {
    let user = this.logApp.currentUser;

    if (!user || !user.isLoggedIn || this.expiredUser(user)) {
      user = await this.logApp.logIn(Realm.Credentials.apiKey(this.APIKey))
    }

    if (!user) {
      throw "Remote Logger User unavailable";
    }

    this.entryBatch = entryBatch;
    this.logSessionId = new ObjectId();

    this.hostApp = app;
    this.realm = await this.openRealm(user);

    Realm.App.Sync.setLogLevel(app, logLevel);
    Realm.App.Sync.setLogger(app, (level, message) => this.addLogEntry(level, message));
  }

  async stopLogging() {
    this.flushEntries();

    await this.realm.syncSession.uploadAllLocalChanges();

    this.realm.close();
  }
}

exports.RemoteLogger = RemoteLogger;
