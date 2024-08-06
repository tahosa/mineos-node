#!/usr/bin/env node

import { dependencies } from './mineos';
import server from './server';
import async from 'async';
import fs from 'fs-extra';
import getopt from 'node-getopt';

import express from 'express';
import compression from 'compression';
import passport from 'passport';
import LocalStrategy from 'passport-local';
import passportSocketIO from 'passport.socketio';
import expressSession from 'express-session';
import bodyParser from 'body-parser';
import methodOverride from 'method-override';
import cookieParser from 'cookie-parser';
import token from 'crypto';
import http from 'node:http';
import https from 'node:https';
import auth from './auth';
import socket from 'socket.io';
import { readIni } from './util';
import 'node:process';

let SOCKET_PORT: number = 8080;

const sessionStore = new expressSession.MemoryStore();
const app = express();
let httpServer: http.Server | https.Server = new http.Server(app);
const response_options = { root: __dirname };

const opt = getopt
  .create([
    [
      'c',
      'config_file=CONFIG_PATH',
      'defaults to $PWD/custom.conf, then /etc/mineos.conf',
    ],
    ['h', 'help', 'display this help'],
  ]) // create Getopt instance
  .bindHelp() // bind option 'help' to default action
  .parseSystem(); // parse command line

const config_file = (opt.options || {}).config_file;

// Authorization
const localAuth = (username, password) =>
  new Promise((resolve, reject) => {
    auth.authenticate_shadow(username, password, (authed_user) => {
      if (authed_user) resolve({ username: authed_user });
      else reject(new Error('incorrect password'));
    });
  });

// Passport init
passport.serializeUser((user, done) => {
  //console.log("serializing " + user.username);
  done(null, user);
});

passport.deserializeUser((obj: any, done) => {
  //console.log("deserializing " + obj);
  done(null, obj);
});

// Use the LocalStrategy within Passport to login users.
passport.use(
  'local-signin',
  new LocalStrategy(
    { passReqToCallback: true }, //allows us to pass back the request to the callback
    (req, username, password, done) => {
      localAuth(username, password)
        .then((user) => {
          if (user) {
            console.log('Successful login attempt for username:', username);
            const logstring =
              new Date().toString() +
              ' - success from: ' +
              req.connection.remoteAddress +
              ' user: ' +
              username +
              '\n';
            try {
              fs.appendFileSync('/var/log/mineos.auth.log', logstring);
            } catch (e) {
              console.log(e);
              console.log(
                'Appending to local repo copy instead: ./mineos.auth.log',
              );
              fs.appendFileSync('mineos.auth.log', logstring);
            }
            done(null, user);
          }
        })
        .catch(() => {
          console.log('Unsuccessful login attempt for username:', username);
          const logstring =
            new Date().toString() +
            ' - failure from: ' +
            req.connection.remoteAddress +
            ' user: ' +
            username +
            '\n';
          try {
            fs.appendFileSync('/var/log/mineos.auth.log', logstring);
          } catch (e) {
            console.log(e);
            console.log(
              'Appending to local repo copy instead: ./mineos.auth.log',
            );
            fs.appendFileSync('mineos.auth.log', logstring);
          }
          done(null);
        });
    },
  ),
);

// clean up sessions that go stale over time
function session_cleanup() {
  //http://stackoverflow.com/a/10761522/1191579
  sessionStore.all((err, sessions) => {
    if (sessions) {
      Object.entries(sessions).forEach(([session]) => {
        sessionStore.get(session, () => {});
      });
    }
  });
}

// Simple route middleware to ensure user is authenticated.
function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) {
    return next();
  }
  req.session.error = 'Please sign in!';
  res.redirect('/admin/login.html');
}

const secret = token.randomBytes(48).toString('hex');

app.use(bodyParser.urlencoded({ extended: false }));
app.use(methodOverride());
app.use(compression());
app.use(
  expressSession({
    secret,
    name: 'express.sid',
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
  }),
);
app.use(passport.initialize());
app.use(passport.session());

const io = socket(httpServer);
io.use(
  passportSocketIO.authorize({
    cookieParser: cookieParser, // the same middleware you registrer in express
    key: 'express.sid', // the name of the cookie where express/connect stores its session_id
    secret: token, // the session_secret to parse the cookie
    store: sessionStore, // we NEED to use a sessionstore. no memorystore please
  }),
);

dependencies((err, binaries) => {
  if (err) {
    console.error('MineOS is missing dependencies:', err);
    console.log(binaries);
    process.exit(1);
  }

  const config_locs = [
    'custom.conf',
    '/etc/mineos.conf',
    '/usr/local/etc/mineos.conf',
  ];

  let mineos_config;
  if (typeof config_file !== 'undefined') {
    console.info(
      'using command-line provided configuration identified as',
      config_file,
    );
    mineos_config = readIni(config_file);
  } else {
    for (const loc in config_locs) {
      try {
        fs.statSync(config_locs[loc]);
        console.info(
          'first mineos configuration identified as',
          config_locs[loc],
        );
        mineos_config = readIni(config_locs[loc]);
        break;
      } catch (e) {
        console.error(e);
      }
    }
  }

  let base_directory = '/var/games/minecraft';

  if ('base_directory' in mineos_config) {
    try {
      if (mineos_config['base_directory'].length < 2)
        throw new Error('Invalid base_directory length.');

      base_directory = mineos_config['base_directory'];
      fs.ensureDirSync(base_directory);
    } catch (e) {
      console.error(e, 'Aborting startup.');
      process.exit(2);
    }
    console.info('using base_directory: ', base_directory);
  } else {
    console.error('base_directory not specified--missing mineos.conf?');
    console.error(
      'alternatively, you can make custom.conf in the repository root directory',
    );
    console.error('Aborting startup.');
    process.exit(4);
  }

  const be = new server(base_directory, io, mineos_config);

  app.get('/', (req, res) => {
    res.redirect('/admin/index.html');
  });

  app.get('/admin/index.html', ensureAuthenticated, (req, res) => {
    res.sendFile('/html/index.html', response_options);
  });

  app.get('/login', (req, res) => {
    res.sendFile('/html/login.html');
  });

  app.post(
    '/auth',
    passport.authenticate('local-signin', {
      successRedirect: '/admin/index.html',
      failureRedirect: '/admin/login.html',
    }),
  );

  app.all('/api/:server_name/:command', ensureAuthenticated, (req, res) => {
    const target_server = req.params.server_name;
    const user = (req.user as any).username;
    const instance = be.servers[target_server];

    const args = req.body;
    args['command'] = req.params.command;

    if (instance) instance.direct_dispatch(user, args);
    else
      console.error(
        'Ignoring request by "',
        user,
        '"; no server found named [',
        target_server,
        ']',
      );

    res.end();
  });

  app.post('/admin/command', ensureAuthenticated, (req, res) => {
    const target_server = req.body.server_name;
    const instance = be.servers[target_server];
    const user = (req.user as any).username;

    if (instance) instance.direct_dispatch(user, req.body);
    else
      console.error(
        'Ignoring request by "',
        user,
        '"; no server found named [',
        target_server,
        ']',
      );

    res.end();
  });

  app.get('/logout', (req, res) => {
    req.logout(() => {});
    res.redirect('/admin/login.html');
  });

  app.use('/socket.io', express.static(__dirname + '/node_modules/socket.io'));
  app.use('/angular', express.static(__dirname + '/node_modules/angular'));
  app.use(
    '/angular-translate',
    express.static(__dirname + '/node_modules/angular-translate/dist'),
  );
  app.use('/moment', express.static(__dirname + '/node_modules/moment'));
  app.use(
    '/angular-moment',
    express.static(__dirname + '/node_modules/angular-moment'),
  );
  app.use(
    '/angular-moment-duration-format',
    express.static(__dirname + '/node_modules/moment-duration-format/lib'),
  );
  app.use(
    '/angular-sanitize',
    express.static(__dirname + '/node_modules/angular-sanitize'),
  );
  app.use('/admin', express.static(__dirname + '/html'));

  process.on('SIGINT', () => {
    console.log('Caught interrupt signal; closing webui....');
    be.shutdown();
    process.exit();
  });

  let SOCKET_HOST = '0.0.0.0';
  let USE_HTTPS = true;

  if ('use_https' in mineos_config) USE_HTTPS = mineos_config['use_https'];

  if ('socket_host' in mineos_config)
    SOCKET_HOST = mineos_config['socket_host'];

  if ('socket_port' in mineos_config)
    SOCKET_PORT = mineos_config['socket_port'];
  else if (USE_HTTPS) SOCKET_PORT = 8443;
  else SOCKET_PORT = 8080;

  if (USE_HTTPS) {
    const keyfile =
      mineos_config['ssl_private_key'] || '/etc/ssl/certs/mineos.key';
    const certfile =
      mineos_config['ssl_certificate'] || '/etc/ssl/certs/mineos.crt';
    async.parallel(
      {
        key: async.apply(fs.readFile, keyfile),
        cert: async.apply(fs.readFile, certfile),
      },
      (err, ssl) => {
        if (err) {
          console.error(
            'Could not locate required SSL files ' +
              keyfile +
              ' and/or ' +
              certfile +
              ', aborting server start.',
          );
          process.exit(3);
        } else {
          if ('ssl_cert_chain' in mineos_config) {
            try {
              const cert_chain_data = fs.readFileSync(
                mineos_config['ssl_cert_chain'],
              );
              if (cert_chain_data.length) ssl['ca'] = cert_chain_data;
            } catch (e) {
              console.error(e);
            }
          }

          httpServer = https
            .createServer(ssl, app)
            .listen(SOCKET_PORT, SOCKET_HOST, () => {
              io.attach(httpServer, {});
              console.log(
                'MineOS webui listening on HTTPS://' +
                  SOCKET_HOST +
                  ':' +
                  SOCKET_PORT,
              );
            });
        }
      },
    );
  } else {
    console.warn('mineos.conf set to host insecurely: starting HTTP server.');
    httpServer.listen(SOCKET_PORT, SOCKET_HOST, () => {
      console.log(
        'MineOS webui listening on HTTP://' + SOCKET_HOST + ':' + SOCKET_PORT,
      );
    });
  }

  setInterval(session_cleanup, 3600000); //check for expired sessions every hour
});

process.on('uncaughtExceptionMonitor', (err) => {
  // Monitor but allow unhandled excaptions to fall through
  console.error(`Uncaught Exception: ${err}`);
  console.error(err.stack);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

process.on('exit', (code) => {
  console.log(`About to exit with code ${code}`);
});
