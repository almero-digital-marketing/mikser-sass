'use strict'

var Promise = require('bluebird');
var fs = require("fs-extra-promise");
var cluster = require('cluster');
var path = require('path');
var minimatch = require("minimatch");
var glob = require('glob-promise');
var express = require('express');
var sass = require('node-sass');
var extend = require('node.extend');
var _ = require('lodash');

module.exports = function (mikser, context) {
	let debug = mikser.debug('sass');
	let sassPattern = '**/*.+(sass|scss)';
	let cssPattern = '**/*.css';
	let sassFolder = path.join(mikser.config.runtimeFolder, 'sass');

	if (context) {
		context.sass = function(source, destination, options) {
			let sourceFile = mikser.utils.findSource(source);
			let defaultOptions = {
				includePaths: [path.dirname(sourceFile),path.join(mikser.options.workingFolder, 'node_modules')],
				sourceMap: true,
				sourceMapEmbed: true
			}
			if (destination && typeof destination != 'string') {
				options = destination;
				destination = undefined;
			}
			let sassInfo = {
				file: sourceFile,
				options: _.defaults(options, defaultOptions)
			}
			if (destination) {
				if (destination.indexOf(mikser.options.workingFolder) !== 0) {
					if (context) {
						sassInfo.outFile = mikser.utils.resolveDestination(destination, context.entity.destination);
					} else {
						sassInfo.outFile = path.join(mikser.options.workingFolder, destination);
					}
				}
				else {
					sassInfo.outFile = destination;
				}
			} else {
				sassInfo.outFile = mikser.utils.predictDestination(source).replace('.sass', '.css').replace('.scss', '.css');
				sassInfo.outFile = mikser.utils.resolveDestination(sassInfo.outFile, context.entity.destination);
			}

			context.process(() => {
				let action;
				if (cluster.isMaster) {
					action = mikser.plugins.sass.process(sassInfo);
				} else {
					action = mikser.broker.call('mikser.plugins.sass.process', sassInfo);
				}
				return action.catch((err) => {
					mikser.diagnostics.log(context, 'error', 'Error processing:', sassInfo.outFile, err);
				});
			});
			return mikser.utils.getUrl(sassInfo.outFile);
		}
	} else {

		if (mikser.config.compile) mikser.config.compile.push('sass');
		else mikser.config.compile = ['sass'];

		if (cluster.isMaster) {

			function isNewer(source, destination) {
				let sassOutput = path.join(sassFolder, destination.replace(mikser.options.workingFolder,'').replace('.css','.json'));
				if (fs.existsSync(sassOutput)) {
					try {
						var sassInfo = fs.readJsonSync(sassOutput);
					} catch (err) {
						debug('Erorr processing', sassOutput, err);
						debug(fs.readFileSync(sassOutput, { encoding: 'utf8' }));
						return true;
					}
					return mikser.utils.isNewer(source, destination) || mikser.utils.isNewer(sassInfo.imports, destination);
				}
				return true;
			}

			return {
				compile: function(file) {
					if (mikser.config.browser && file && minimatch(file, sassPattern)) {
						return glob('**/*.json', { cwd: sassFolder }).then((outputFiles) => {
							if (outputFiles.length) {
								let recompile = [];
								return Promise.map(outputFiles, (outputFile) => {
									let sassOutput = path.join(sassFolder, outputFile);
									return fs.readJsonAsync(sassOutput).then((sassInfo) => {
										if (sassInfo.file == file || sassInfo.imports.indexOf(file) != -1) {
											recompile.push(sassInfo);
											//console.log(output.info.destination);
											mikser.emit('mikser.watcher.outputAction', 'compile', sassInfo.outFile);
										}
									});
								}).then(() => {
									console.log('Sass compile:', recompile.length);
									return Promise.map(recompile, mikser.plugins.sass.process);
								}).then(() => {
									return Promise.resolve(recompile.length > 0);	
								});
							}
						});
					}
					return Promise.resolve(false);
				},
				process: function(sassInfo) {
					if (isNewer(sassInfo.file, sassInfo.outFile)) {
						let capturedOptions = extend(true, {}, sassInfo.options);
						return fs.readFileAsync(sassInfo.file, { encoding: 'utf8' })
							.then((input) => {
								sassInfo.options.data = input;
								return Promise.promisify(sass.render)(sassInfo.options);
							})
							.then((output) => {
								debug('Processed:', sassInfo.file);
								let sassOutput = path.join(sassFolder, sassInfo.outFile.replace(mikser.options.workingFolder,'').replace('.css','.json'));
								return Promise.join(
									fs.outputFileAsync(sassInfo.outFile, output.css),
									fs.outputJson(sassOutput, {
										file: sassInfo.file,
										outFile: sassInfo.outFile,
										imports: output.stats.includedFiles,
										options: capturedOptions
									})
								);
							});
					}
					return Promise.resolve();
				}
			}
		}
	}

}