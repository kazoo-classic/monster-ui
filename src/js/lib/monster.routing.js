define(function(require) {
	var $ = require('jquery'),
		_ = require('lodash'),
		monster = require('monster'),
		crossroads = require('crossroads'),
		hasher = require('hasher');

	var loadApp = function(appName, query) {
		var isAccountIDMasqueradable = function(id) {
			return /^[0-9a-f]{32}$/i.test(id) && (monster.apps.auth.currentAccount.id !== id);
		};

		monster.series([
			// See if we have a 'm' query string (masquerading), and see if it's an ID, if yes, then trigger an attempt to masquerade
			function(cb) {
				if (
					!_.has(query, 'm')
					|| !isAccountIDMasqueradable(query.m)
				) {
					return cb(null);
				}
				monster.pub('core.triggerMasquerading', {
					account: { id: query.m },
					callback: function() {
						cb(null);
					}
				});
			}
		], function(err, results) {
			if (
				appName !== 'appstore'
				&& monster.util.isMasquerading()
				&& monster.appsStore[appName].masqueradable !== true
			) {
				monster.ui.toast({
					type: 'error',
					message: monster.apps.core.i18n.active().appMasqueradingError
				});
				return;
			}
			monster.pub('apploader.hide');
			monster.pub('myaccount.hide');

			monster.apps.load(appName, function(loadedApp) {
				monster.pub('core.alerts.refresh');
				monster.pub('core.showAppName', appName);
				$('#monster_content').empty();

				loadedApp.render($('#monster_content'));
			});
		});
	};

	var isAppLoadable = function(appName, availableApps) {
		if (
			appName === 'appstore'
			&& monster.apps.auth.currentUser.priv_level === 'admin'
		) {
			return true;
		} else if (_.find(availableApps, { name: appName })) {
			return true;
		}
		return false;
	};

	var routing = {
		routes: [],

		goTo: function(url) {
			this.updateHash(url);

			this.parseHash(url);
		},

		getUrl: function() {
			return hasher.getHash();
		},

		add: function(url, callback) {
			var currentUrl = this.getUrl();

			this.routes.push(crossroads.addRoute(url, callback));

			if (currentUrl === url) {
				this.parseHash(url);
			}
		},

		addDefaultRoutes: function() {
			this.add('apps/{appName}:?query:', function(appName, query) {
				// not logged in, do nothing to preserve potentially valid route to load after successful login
				if (!monster.util.isLoggedIn()) {
					return;
				}
				monster.pub('apploader.getAppList', {
					scope: 'user',
					accountId: _.get(monster.apps.auth, [
						monster.util.isMasquerading() ? 'originalAccount' : 'currentAccount',
						'id'
					]),
					success: function(availableApps) {
						// try loading the requested app
						if (isAppLoadable(appName, availableApps)) {
							loadApp(appName, query);
						} else {
							var activeApp = monster.apps.getActiveApp();

							routing.updateHash(
								isAppLoadable(activeApp, availableApps)
									? 'apps/' + activeApp
									: ''
							);

							monster.pub('apploader.show', {
								callback: monster.ui.toast.bind(monster.ui, {
									message: monster.apps.core.i18n.active().unableToAccessApp
								})
							});
						}
					},
					error: monster.util.logoutAndReload.bind(monster.util)
				});
			});
		},

		hasMatch: function() {
			return crossroads._getMatchedRoutes(this.getUrl()).length > 0;
		},

		init: function() {
			var self = this,
				onEvent = function(newHash, oldHash) {
					self.parseHash(newHash, oldHash);
				};

			this.addDefaultRoutes();

			hasher.initialized.add(onEvent); // parse initial hash
			hasher.changed.add(onEvent); // parse hash changes
			hasher.init(); // start listening for history changes

			crossroads.ignoreState = true;
		},

		parseHash: function(newHash) {
			if (!newHash || newHash === '') {
				newHash = this.getUrl();
			}

			crossroads.parse(newHash);
		},

		// We silence the event so it only changes the URL.
		updateHash: function(url) {
			hasher.changed.active = false; //disable changed signal

			hasher.setHash(url); //set hash without dispatching changed signal

			hasher.changed.active = true; //re-enable signal
		}
	};

	return routing;
});
