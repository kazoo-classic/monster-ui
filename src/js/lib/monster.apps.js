define(function() {
	var $ = require('jquery'),
		_ = require('lodash'),
		monster = require('monster');

	var apps = {
		// Global var used to show the loading gif
		uploadProgress: {
			amount: 0,
			active: false,
			runningApis: 0
		},

		monsterizeApp: function(app, callback) {
			var self = this;

			_.each(app.requests, function(request, id) {
				monster._defineRequest(id, request, app);
			});

			_.each(app.subscribe, function(callback, topic) {
				var cb = typeof callback === 'string' ? app[callback] : callback;

				monster.sub(topic, cb, app);
			});

			self._addAppCss(app);

			self._addAppI18n(app);

			app.uiFlags = {
				user: {
					set: function(flagName, value, user) {
						return monster.util.uiFlags.user.set(app.name, flagName, value, user);
					},
					get: function(flagName, user) {
						return monster.util.uiFlags.user.get(app.name, flagName, user);
					},
					destroy: function(flagName, user) {
						return monster.util.uiFlags.user.destroy(app.name, flagName, user);
					}
				},
				account: {
					set: function(flagName, value, account) {
						return monster.util.uiFlags.account.set(app.name, flagName, value, account);
					},
					get: function(flagName, account) {
						return monster.util.uiFlags.account.get(app.name, flagName, account);
					},
					destroy: function(flagName, account) {
						return monster.util.uiFlags.account.destroy(app.name, flagName, account);
					}
				}
			};

			app.getTemplate = function(args) {
				args.app = app;

				return monster.getTemplate(args);
			};

			// Active means it's in the DOM. It could be hidden by the Myaccount or apploader and still be "active".
			app.isActive = function() {
				return app.name === monster.apps.getActiveApp();
			};

			/**
			 * @param  {Object} params
			 * @param  {String} [params.accountId]
			 * @param  {String} params.binding
			 * @param  {Function} params.callback
			 * @param  {jQuery} [params.requiredElement]
			 */
			app.subscribeWebSocket = function(params) {
				var accountId = app.accountId || params.accountId,
					requiredElement = params.hasOwnProperty('requiredElement') ? params.requiredElement : false;

				var unsubscribe = monster.socket.bind({
					binding: params.binding,
					accountId: accountId,
					callback: params.callback,
					source: app.name
				});

				if (requiredElement) {
					requiredElement.on('remove', unsubscribe);
				}
			};

			/**
			 * @param  {Object} params
			 * @param  {String} [params.accountId]
			 * @param  {String} params.binding
			 */
			app.unsubscribeWebSocket = function(params) {
				var accountId = app.accountId || params.accountId;

				monster.socket.unbind({
					binding: params.binding,
					accountId: accountId,
					source: app.name
				});
			};

			/**
			 * @param  {Object} args
			 * @param  {Function} args.callback
			 * @param  {Function} [args.error]
			 */
			app.enforceWebSocketsConnection = function(args) {
				app.requiresWebSockets = true;

				monster.pub('core.socket.showDisconnectToast');

				if (
					!monster.socket.getInfo().isConnected
					&& _.isFunction(args.error)
				) {
					args.error();
				} else {
					args.callback();
				}
			};

			app.callApi = function(params) {
				var apiSplit = params.resource.split('.'),
					module = apiSplit[0],
					method = apiSplit[1],
					successCallback = params.success,
					errorCallback = params.error,
					cancelCall = false; //Used to cancel the Api Call before it is actually sent

				if (apiSplit.length === 2 && module in monster.kazooSdk && method in monster.kazooSdk[module]) {
					//Handling special cases:
					switch (params.resource) {
						case 'account.update':
						case 'account.patch':
							successCallback = function(data, status) {
								if (params.data.accountId === monster.apps.auth.currentAccount.id) {
									monster.apps.auth.currentAccount = data.data;
									monster.pub('auth.currentAccountUpdated', data.data);
								}

								if (params.data.accountId === monster.apps.auth.originalAccount.id) {
									monster.apps.auth.originalAccount = data.data;
									monster.pub('auth.originalAccountUpdated', data.data);
								}

								params.success && params.success(data, status);
							};

							break;

						case 'user.list':
							successCallback = function(data, status) {
								data.data.sort(function(a, b) {
									return monster.util.cmp(a.first_name.toLowerCase(), b.first_name.toLowerCase()) || monster.util.cmp(a.last_name.toLowerCase(), b.last_name.toLowerCase());
								});

								params.success && params.success(data, status);
							};
							break;

						case 'conference.get':
							successCallback = function(data, status) {
								if (data.data.member.numbers.length && data.data.conference_numbers.length === 0) {
									data.data.conference_numbers = data.data.member.numbers;
									data.data.member.numbers = [];

									app.callApi({
										resource: 'conference.update',
										data: {
											accountId: app.accountId,
											conferenceId: data.data.id,
											data: data.data
										},
										success: function(data, status) {
											params.success && params.success(data, status);
										}
									});
								} else {
									params.success && params.success(data, status);
								}
							};
							break;
						case 'user.update':
						case 'user.patch':
							// If we're updating the user we're logged in with
							if (params.data.userId === monster.apps.auth.userId) {
								successCallback = function(data, status) {
									monster.apps.auth.currentUser = data.data;
									monster.pub('auth.currentUserUpdated', data.data);

									if (params.data.data.hasOwnProperty('password')) {
										monster.pub('auth.currentUserUpdatedPassword', { user: data.data, password: params.data.data.password });
									}

									var cookieData = monster.cookies.getJson('monster-auth');

									// If the language stored in the cookie is not the same as the one we have in the updated data, we update the cookie.
									if (cookieData.language !== data.data.language) {
										cookieData.language = data.data.language;
										monster.cookies.set('monster-auth', cookieData);
									}

									params.success && params.success(data, status);
								};
							}
							break;

						case 'billing.get':
						case 'billing.update':
							if (monster.config.disableBraintree) {
								cancelCall = true;
							}
							break;

						case 'numbers.get':
							// MIGRATION AWAY FROM PROVIDER SPECIFIC e911
							successCallback = function(data, status) {
								if (data.data.hasOwnProperty('dash_e911') && !data.data.hasOwnProperty('e911')) {
									data.data.e911 = data.data.dash_e911;
									delete data.data.dash_e911;
								}

								params.success && params.success(data, status);
							};
							break;
						case 'numbers.update':
							// MIGRATION AWAY FROM PROVIDER SPECIFIC e911
							if (params.data.data.hasOwnProperty('dash_e911')) {
								if (!params.data.data.hasOwnProperty('e911')) {
									params.data.data.e911 = $.extend(true, params.data.data.dash_e911);
								}

								delete params.data.data.dash_e911;
							}
							break;

						case 'whitelabel.getByDomain':
						case 'whitelabel.create':
						case 'whitelabel.update':
						case 'whitelabel.get':
							successCallback = function(data, status) {
								if (data && data.hasOwnProperty('data') && data.data.hasOwnProperty('domain') && window.location.hostname === data.data.domain.toLowerCase()) {
									var whitelabelData = data.data;

									// Merge the whitelabel info to replace the hardcoded info
									if (whitelabelData && whitelabelData.hasOwnProperty('company_name')) {
										whitelabelData.companyName = whitelabelData.company_name;
									}

									monster.config.whitelabel = $.extend(true, {}, monster.config.whitelabel, whitelabelData);
								}

								params.success && params.success(data, status);
							};
							break;

						// APIs that will trigger the upload progress bar
						case 'media.upload':
						case 'port.createAttachment':
						case 'port.updateAttachment':
						case 'whitelabel.updateLogo':
						case 'whitelabel.updateIcon':
							if (!params.data.hasOwnProperty('uploadProgress')) {
								self.uploadProgress.runningApis++;
								var progressId = 'progress_' + Math.trunc(Math.random() * Math.pow(10, 16)),
									container = $('#upload_progress'),
									hideContainer = function() {
										if (!self.uploadProgress.active && self.uploadProgress.runningApis === 0) {
											container.hide();
										}
									};

								params.data.uploadProgress = function(progress) {
									if (progress.lengthComputable) {
										var progressValue = progress.loaded / progress.total * 100,
											progressBar = container.find('#' + progressId);
										if (progressValue === 100) {
											if (self.uploadProgress.active && progressBar.length) {
												progressBar
													.children('div')
														.width('99%')
														.html('99%');
												self.uploadProgress.amount--;
												if (self.uploadProgress.amount === 0) {
													self.uploadProgress.active = false;
													hideContainer();
												}
											}
										} else {
											if (!self.uploadProgress.active) {
												container.show();
												self.uploadProgress.active = true;
											}
											if (!progressBar.length) {
												progressBar = $('<div id="' + progressId + '" class="upload-progress-bar"><div>0%</div></div>');
												container.find('.upload-progress-content').append(progressBar);
												self.uploadProgress.amount++;
											}
											progressBar
												.children('div')
													.width(progressValue + '%')
													.html(Math.floor(progressValue) + '%');
										}
									}
								};

								successCallback = function(data, status) {
									self.uploadProgress.runningApis--;
									container.find('#' + progressId).remove();
									hideContainer();
									params.success && params.success(data, status);
								};

								errorCallback = function(error, status) {
									self.uploadProgress.runningApis--;
									self.uploadProgress.active = false;
									container.find('#' + progressId).remove();
									hideContainer();
									params.error && params.error(error, status);
								};
							}
							break;
					}

					if (cancelCall) {
						return errorCallback && errorCallback();
					} else {
						var apiSettings = _.assignIn({	// lodash#assignIn is used here to have a shallow merge (only top level properties)
							authToken: params.authToken || app.getAuthToken(),
							apiRoot: params.apiUrl || app.apiUrl,
							uiMetadata: {
								version: monster.util.getVersion(),
								ui: 'monster-ui',
								origin: app.name
							},
							success: successCallback,
							error: errorCallback,
							headers: {},
							requestEventParams: _.pick(params, 'bypassProgressIndicator')
						},
						params.data,
						monster.config.whitelabel.acceptCharges.autoAccept ? {
							acceptCharges: monster.config.whitelabel.acceptCharges.autoAccept
						} : {},
						_.pick(params, 'onChargesCancelled')
						);

						if (_.has(monster.config, 'kazooClusterId')) {
							apiSettings.headers['X-Kazoo-Cluster-ID'] = monster.config.kazooClusterId;
						}

						return monster.kazooSdk[module][method](apiSettings);
					}
				} else {
					console.error('This api does not exist. Module: ' + module + ', Method: ' + method);
				}
			};

			// We want to abstract this function at the app layer in case we'd need to check things like masquerading here.
			app.getAuthToken = function(connectionName) {
				return monster.util.getAuthToken(connectionName);
			};

			monster.apps[app.name] = app;

			self.loadDependencies(app, function() {
				app.load(callback);
			});
		},

		/**
		 * @param  {Object} app
		 * @param  {Function} [globalCallback]
		 */
		loadDependencies: function(app, globalCallback) {
			var self = this,
				currentUser = _.get(monster, 'apps.auth.currentUser', {}),
				isExtensionPermitted = function isExtensionPermitted(extensionName, user) {
					var extension = _.get(monster, ['appsStore', extensionName], {}),
						level = extension.allowed_users,
						users = _
							.chain(extension)
							.get('users', [])
							.map('id')
							.value();

					return (level === 'all')
						|| (level === 'admins' && user.priv_level === 'admin')
						|| (level === 'specific' && _.includes(users, user.id));
				},
				dependencies = _
					.chain(app)
					.get('externalScripts', [])
					.map(function(dependency) {
						return function(callback) {
							monster.getScript(
								app.appPath + '/external/' + dependency + '.js',
								_.partial(callback, null)
							);
						};
					})
					.value(),
				extensions = _
					.chain(monster)
					.get(['appsStore', app.name, 'extensions'], [])
					.reject(function(extension) {
						var isNotInAppStore = !_.has(monster, ['appsStore', extension]),
							isAlreadyLoaded = _.has(monster, ['apps', extension]),
							isNotPermittedForLoggedInUser = !isExtensionPermitted(extension, currentUser);

						return isNotInAppStore
							|| isAlreadyLoaded
							|| isNotPermittedForLoggedInUser;
					})
					.map(function(extension) {
						return function(callback) {
							self._loadApp(extension, _.partial(callback, null));
						};
					})
					.value();

			monster.parallel(
				_.concat(
					dependencies,
					extensions
				),
				function(err, results) {
					globalCallback && globalCallback();
				}
			);
		},

		_addAppCss: function(app) {
			var self = this,
				listCss = [],
				currentLanguage = monster.config.whitelabel.language,
				addCss = function(fileName) {
					fileName = app.appPath + '/style/' + fileName + '.css';

					monster.css(fileName);
				};

			// If the app wasn't already loaded by our build (it minifies and concatenate some apps)
			if ((monster.config.developerFlags.build.preloadedApps || []).indexOf(app.name) < 0) {
				listCss = app.css;
			}

			// If the current UI Language is not the default of the Monster UI, see if we have a specific i18n file to load
			if (currentLanguage !== monster.defaultLanguage) {
				if (app.i18n.hasOwnProperty(currentLanguage) && app.i18n[currentLanguage].customCss === true) {
					listCss.push('cssI18n/' + currentLanguage);
				}
			}

			_.each(listCss, function(fileName) {
				addCss(fileName);
			});
		},

		_addAppI18n: function(app) {
			var self = this;

			_.extend(app.data, { i18n: {} });

			// We'll merge the Core I18n once we're done loading the different I18n coming with the application
			var addCoreI18n = function() {
				if (monster.apps.hasOwnProperty('core')) {
					$.extend(true, app.data.i18n, monster.apps.core.data.i18n);
				}
			};

			// We automatically load the default language (en-US) i18n files
			self.loadLocale(app, monster.defaultLanguage, function() {
				// If the preferred language of the user is supported by the application and different from the default language, we load its i18n files.
				if (monster.config.whitelabel.language.toLowerCase() !== monster.defaultLanguage.toLowerCase()) {
					self.loadLocale(app, monster.config.whitelabel.language, function() {
						// We're done loading the i18n files for this app, so we just merge the Core I18n to it.
						addCoreI18n();
					});
				} else {
					// We're done loading the i18n files for this app, so we just merge the Core I18n to it.
					addCoreI18n();
				}
			});

			// add an active property method to the i18n array within the app.
			_.extend(app.i18n, {
				active: function() {
					var language = app.i18n.hasOwnProperty(monster.config.whitelabel.language) ? monster.config.whitelabel.language : monster.defaultLanguage;

					return app.data.i18n[language];
				}
			});
		},

		/**
		 * @param  {String}   name
		 * @param  {Function} [callback]
		 * @param  {Object}   [options={}]
		 * @param  {String}   [options.sourceUrl]
		 * @param  {String}   [options.apiUrl]
		 */
		_loadApp: function(name, callback, options) {
			var self = this,
				appPath = 'apps/' + name,
				customKey = 'app-' + name,
				requirePaths = {},
				options = options || {},
				externalUrl = options.sourceUrl || false,
				apiUrl = monster.config.api.default;

			/* If source_url is defined for an app, we'll load the templates, i18n and js from this url instead of localhost */
			if ('auth' in monster.apps && 'installedApps' in monster.apps.auth) {
				var storedApp = _.find(monster.apps.auth.installedApps, function(installedApp) {
					return name === installedApp.name;
				});

				if (storedApp && 'source_url' in storedApp) {
					externalUrl = storedApp.source_url;

					if (externalUrl.substr(externalUrl.length - 1) !== '/') {
						externalUrl += '/';
					}
				}

				if (storedApp && storedApp.hasOwnProperty('api_url')) {
					apiUrl = storedApp.api_url;
					if (apiUrl.substr(apiUrl.length - 1) !== '/') {
						apiUrl += '/';
					}
				}
			}

			if (externalUrl) {
				appPath = externalUrl;

				requirePaths[customKey] = externalUrl + '/app';

				require.config({
					paths: requirePaths
				});
			}

			var path = customKey in requirePaths ? customKey : appPath + '/app';

			require([path], function(app) {
				_.extend(app, { appPath: appPath, data: {} }, monster.apps[name], { apiUrl: apiUrl });

				app.name = name; // we don't want the name to be set by the js, instead we take the name supplied in the app.json

				if (options && 'apiUrl' in options) {
					app.apiUrl = options.apiUrl;
				}

				var afterConfig = function(config) {
					app.buildConfig = config;

					if (app.buildConfig.version === 'pro') {
						if (!app.hasOwnProperty('subModules')) {
							app.subModules = [];
						}

						app.subModules.push('pro');
					}

					if ('subModules' in app && app.subModules.length > 0) {
						var toInit = app.subModules.length,
							loadModule = function(subModule, callback) {
								var pathSubModule = app.appPath + '/submodules/',
									path = pathSubModule + subModule + '/' + subModule;

								require([path], function(module) {
									/* We need to be able to subscribe to the same event with many callbacks, so we can't merge the subscribes key together, or it would override some valid callbacks */
									var oldSubscribes = $.extend(true, {}, app.subscribe);
									$.extend(true, app, module);
									app.subscribe = oldSubscribes;

									_.each(module.subscribe, function(callback, topic) {
										var cb = typeof callback === 'string' ? app[callback] : callback;

										monster.sub(topic, cb, app);
									});

									callback && callback();
								});
							};

						_.each(app.subModules, function(subModule) {
							loadModule(subModule, function() {
								toInit--;

								if (toInit === 0) {
									self.monsterizeApp(app, callback);
								}
							});
						});
					} else {
						self.monsterizeApp(app, callback);
					}
				};

				if (app.hasConfigFile) {
					monster.pub('monster.requestStart');
					$.ajax({
						url: app.appPath + '/app-build-config.json',
						dataType: 'json',
						async: false,
						success: function(data) {
							afterConfig(data);

							monster.pub('monster.requestEnd');
						},
						error: function(data, status, error) {
							afterConfig({});

							monster.pub('monster.requestEnd');
						}
					});
				} else {
					afterConfig({});
				}
			}, callback);
		},

		/**
		 * @param  {String}   name
		 * @param  {Function} [callback]
		 * @param  {Object}   [options]
		 */
		load: function(name, callback, options) {
			var self = this;

			monster.waterfall([
				function maybeLoadApp(waterfallCb) {
					if (_.has(monster.apps, name)) {
						return waterfallCb(null, monster.apps[name]);
					}
					self._loadApp(name, waterfallCb.bind(null, null), options);
				}
			], function afterAppLoad(err, app) {
				monster.apps.lastLoadedApp = app.name;

				self.changeAppShortcuts(app);

				callback && callback(app);
			});
		},

		changeAppShortcuts: function(app) {
			monster.ui.removeShortcut('appSpecific');

			var i18nShortcuts = app.i18n.active().shortcuts;

			if (app.hasOwnProperty('shortcuts')) {
				_.each(app.shortcuts, function(event, key) {
					monster.ui.addShortcut({
						category: 'appSpecific',
						key: 'alt+' + key,
						callback: function() {
							monster.pub(event);
						},
						title: i18nShortcuts && i18nShortcuts.hasOwnProperty(key) ? i18nShortcuts[key] : event
					});
				});
			}
		},

		getActiveApp: function() {
			return monster.apps.lastLoadedApp;
		},

		loadLocale: function(app, language, callback) {
			var self = this,
				// Automatic upper case for text after the hyphen (example: change en-us to en-US)
				language = language.replace(/-.*/, function(a) { return a.toUpperCase(); }),
				loadFile = function(afterLoading) {
					monster.pub('monster.requestStart');

					$.ajax({
						url: monster.util.cacheUrl(app.appPath + '/i18n/' + language + '.json'),
						dataType: 'json',
						async: false,
						success: function(data) {
							afterLoading && afterLoading(data);

							monster.pub('monster.requestEnd');
						},
						error: function(data, status, error) {
							afterLoading && afterLoading({});

							monster.pub('monster.requestEnd');

							console.log('_loadLocale error: ', status, error);
						}
					});
				};

			if (app.i18n.hasOwnProperty(language)) {
				loadFile(function(data) {
					// If we're loading the default language, then we add it, and also merge the core i18n to it
					if (language === monster.defaultLanguage) {
						app.data.i18n[language] = data;
					} else {
						// Otherwise, if we load a custom language, we merge the translation to the en-one
						app.data.i18n[language] = $.extend(true, app.data.i18n[language] || {}, app.data.i18n[monster.defaultLanguage], data);
					}

					callback && callback();
				});
			} else {
				console.info(language + ' isn\'t a supported language by this application: ' + app.name);

				callback && callback();
			}
		}
	};

	return apps;
});
