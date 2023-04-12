#!/usr/bin/env node

const ora = require('ora');
const minimist = require('minimist');
const Realm = require("realm");
const constants = require('./constants');
const { EJSON } = require('bson');
const { RemoteLogger } = require('./RemoteLogger');

let app = null;

let realm;
let args = {};
const spinner = ora("Working…");
const remoteLogger = new RemoteLogger('<Logging App ID>', '<API Key>');

function logWithDate(message) {
  let date = new Date();

  console.log(`[${date.toISOString()}] - ${message}`)
}

function compactOnLaunch(totalBytes, usedBytes) {
  let tenMB = 10485760;

  if ((totalBytes > tenMB) && ((totalBytes - usedBytes) > tenMB)) {
    spinner.text = `Compacting Realm…`;

    return true;
  }

  return false;
}

async function openRealm(user) {
  try {
    const config = {
      shouldCompact: compactOnLaunch,
      sync: {
        user: user,
        flexible: true,
        clientReset: { mode: Realm.ClientResetMode.RecoverOrDiscardUnsyncedChanges },
        newRealmFileBehavior: { type: 'downloadBeforeOpen', timeOutBehavior: 'throwException' },
        existingRealmFileBehavior: { type: 'openImmediately', timeOutBehavior: 'openLocalRealm' },
      }
    };

    if (args.clean) {
      Realm.deleteFile(config);
      logWithDate('Cleaned realm');
    }

    spinner.text = 'Opening realm…';
    spinner.start();

    realm = await Realm.open(config);

    spinner.succeed('Opened realm');
  } catch (e) {
    spinner.fail(`${EJSON.stringify(e, null, 2)}`);
  }
}

function queryClasses(realm) {
  const realm_schema = realm.schema;

  var classes = [];

  for (const objSchema of realm_schema.sort((a, b) => a['name'] < b['name'])) {
    classes.push(objSchema);
  }

  return classes;
}

function trackClass(className) {
  let objects = realm.objects(className);

  logWithDate(`Got ${objects.length} ${className} objects`)
}

function parseCLIParameters() {
  args = minimist(process.argv.slice(2));

  if (args.appId) {
    constants.appConfig.id = args.appId;
  } else {
    throw "App ID is undefined - please pass it in the command line '--appId=xxxx-yyyy'"
  }

  if (args.logLevel) {
    constants.logLevel = args.logLevel;
  }

  if (args.user) {
    constants.username = args.user;
  }

  if (args.password) {
    constants.password = args.password;
  }

  if (args.apiKey) {
    constants.userAPIKey = args.apiKey;
  }
}

async function run() {
  try {
    parseCLIParameters();

    app = new Realm.App(constants.appConfig);

    await remoteLogger.startLogging(app, constants.logLevel);

    let user = app.currentUser;

    if (args.clean && user && user.isLoggedIn) {
      await user.logOut();
    }

    if (!user || !user.isLoggedIn) {
      let credentials;

      if (constants.username.length > 0) {
        credentials = Realm.Credentials.emailPassword(constants.username, constants.password);
      } else if (constants.userAPIKey.length > 0) {
        credentials = Realm.Credentials.apiKey(constants.userAPIKey);
      } else {
        credentials = Realm.Credentials.anonymous();
      }

      user = await app.logIn(credentials);

      logWithDate(`Logged in with the user: ${user.id}`);
    } else {
      logWithDate(`Skipped login with the user: ${user.id}`);
    }

    await openRealm(user);

    if (realm) {
      let synchedClasses = queryClasses(realm);

      spinner.text = `Updating subscriptions…`;
      spinner.start();

      await realm.subscriptions.update((mutableSubs) => {
        for (const objSchema of synchedClasses) {
          if (!objSchema['embedded']) {
            const objects = realm.objects(objSchema['name']);

            mutableSubs.add(objects, { name: `All ${objSchema['name']}` });
          }
        }
      });

      spinner.succeed(`Subscriptions updated`);
      for (const objSchema of synchedClasses) {
        if (!objSchema['embedded']) {
          trackClass(objSchema['name']);
        }
      }
    }
  } catch (error) {
    console.error(error);
    spinner.fail(`Error ${error}`);
  } finally {
    setTimeout(async () => {
      if (realm) {
        realm.close();
      }

      logWithDate("Done");

      await remoteLogger.stopLogging();

      process.exit(0);
    }, 5000);
  }
}

run().catch(console.dir);
