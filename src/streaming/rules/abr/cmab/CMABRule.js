/**
 * The copyright in this software is being made available under the BSD License,
 * included below. This software may be subject to other third party and contributor
 * rights, including patent rights, and no such rights are granted under this license.
 *
 * Copyright (c) 2013, Dash Industry Forum.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *  * Redistributions of source code must retain the above copyright notice, this
 *  list of conditions and the following disclaimer.
 *  * Redistributions in binary form must reproduce the above copyright notice,
 *  this list of conditions and the following disclaimer in the documentation and/or
 *  other materials provided with the distribution.
 *  * Neither the name of Dash Industry Forum nor the names of its
 *  contributors may be used to endorse or promote products derived from this software
 *  without specific prior written permission.
 *
 *  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS AS IS AND ANY
 *  EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 *  WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
 *  IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT,
 *  INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT
 *  NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
 *  PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
 *  WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 *  ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 *  POSSIBILITY OF SUCH DAMAGE.
 */

/**
 * Authors:
 * Jinwei Zhao | University of Victoria | clarkzjw@uvic.ca, clarkzjw@gmail.com
 */

import FactoryMaker from '../../../../core/FactoryMaker';
import Constants from '../../../constants/Constants';
import MetricsConstants from '../../../constants/MetricsConstants';
import CMABAbrController from './CMABAbrController';
import MediaPlayerEvents from '../../../MediaPlayerEvents';
import EventBus from '../../../../core/EventBus';
import CoreEvents from '../../../../core/events/Events';
import Settings from '../../../../core/Settings';

const { loadPyodide } = require('pyodide');
const statServerUrl = 'http://stat-server:8000';
const pyodideLoadingUrl = 'http://pyodide/pyodide/';

async function sendStats(url, type, stat) {
    try {
        await fetch(url, {
            credentials: 'omit',
            mode: 'cors',
            method: 'post',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: stat })
        });

    } catch (error) {
        console.log('send stats error: ', error);
    }
}

function cmabLog(msg) {
    console.log(JSON.parse(JSON.stringify(msg)))
}

function getLatestNetworkLatency() {
    let LatencySidecarURL = statServerUrl + '/ping';

    const xhr = new XMLHttpRequest();
    xhr.open('GET', LatencySidecarURL, false);
    xhr.send(null);
    if (xhr.status === 200) {
        return parseFloat(xhr.responseText.replace(/\n$/, ''));
    } else {
        throw new Error('Request failed: ' + xhr.statusText);
    }
}

function getHistory(url) {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, false);
    xhr.setRequestHeader('Content-Type', 'application/json');

    try {
        xhr.send(null);

        if (xhr.status === 200) {
            return JSON.parse(xhr.responseText);
        } else {
            return null;
        }
    } catch (err) {
        return null;
    }
}

function getLatencyHistory() {
    const url = statServerUrl + '/pingstats';
    return getHistory(url);
}

function getThroughputHistory() {
    const url = statServerUrl + '/throughputstats';
    return getHistory(url);
}

function isSameSatelliteTimeSlot(t1, t2) {
    // 12, 27, 42, 57

    // if the difference between two timestamps > 15 seconds,
    // they definitely belong to different satellite timeslots
    if ((t2 - t1) / 1000.0 > 15) {
        return false
    }
    let t1_minute = t1.getMinutes();
    let t2_minute = t2.getMinutes();

    // if their minute difference > 1,
    // they definitely belong to different satellite timeslots
    if (t2_minute - t1_minute > 1) {
        return false
    }

    let t1_second = t1.getSeconds();
    let t2_second = t2.getSeconds();

    // if they are in adjacent minutes,
    // and t1 > 57, t2 < 12, they belong to the same timeslot
    if ((t2_minute - t1_minute === 1) && (t1_second > 57 && t2_second <= 12)) {
        return true
    }

    // if they are in the same minute
    if (t1_minute === t2_minute) {
        if (t1_second <= 12 && t2_second <= 12) {
            return true
        }
        if ((t1_second > 12 && t1_second <= 27) && (t2_second > 12 && t2_second <= 27)) {
            return true
        }
        if ((t1_second > 27 && t1_second <= 42) && (t2_second > 27 && t2_second <= 42)) {
            return true
        }
        if ((t1_second > 42 && t1_second <= 57) && (t2_second > 42 && t2_second <= 57)) {
            return true
        }
        if ((t1_second > 57 && t2_second > 57)) {
            return true
        }
    }

    return false
}

function CMABRule(config) {
    config = config || {};

    let dashMetrics = config.dashMetrics;
    let factory = dashjs.FactoryMaker;
    let SwitchRequest = factory.getClassFactoryByName('SwitchRequest');
    let context = this.context;

    const eventBus = EventBus(context).getInstance();

    let instance;
    let cmabArms = null;
    let pyodide = null;

    let CMABController;
    let player_settings;
    let playbackBufferMin;

    let audioCodec = 'aaclc';
    let audioBitrate = -1;
    let currentBitrate;
    let currentBitrateKbps;
    let lastStallTime = null;
    let lastRebufferingBitrate = null;
    let rebufferingEvents = new Map();
    let cmabAlpha = null;
    let experimentID = 'default';
    let manifest = null;
    let pyodide_init_done = false;

    let start_time = new Date();

    let bufferLevelHistory = [];
    let bufferLevelMovingAverage = -1;

    let _py_import_test = `
    import pandas as pd
    from mabwiser.mab import MAB, LearningPolicy, NeighborhoodPolicy
    from sklearn.preprocessing import StandardScaler
    `

    let agent_context = [];
    let starlink_timeslot_count = 0;
    let previous_decision_making_time = new Date();

    async function init_pyodide() {
        console.log('[CMAB] Loading Pyodide...');
        let requirements = [
            'pandas',
            'scikit-learn',
            pyodideLoadingUrl + 'mabwiser-2.7.0-py3-none-any.whl',
            pyodideLoadingUrl + 'itu_p1203-1.9.5-py3-none-any.whl',
        ]

        pyodide = await loadPyodide({ indexURL: pyodideLoadingUrl});
        await pyodide.loadPackage(requirements);
        pyodide.runPython(_py_import_test);
        console.log('Time: ', new Date(), 'Pyodide ready');
        return pyodide;
    }

    function setup() {
        player_settings = Settings(context).getInstance()
        cmabAlpha = player_settings.get().streaming.abr.cmab.alpha;
        experimentID = player_settings.get().streaming.abr.cmab.experimentID;
        playbackBufferMin = player_settings.get().streaming.liveCatchup.playbackBufferMin;

        eventBus.on(CoreEvents.MANIFEST_UPDATED, (e) => {
            manifest = e.manifest;
            console.log('[CMAB] Manifest Updated:', manifest);
            if (pyodide_init_done) {
                eventBus.trigger(CoreEvents.CMAB_MANIFEST_LOADED, { manifest: manifest })
            }
        }, instance);

        init_pyodide().then((_pyodide) => {
            pyodide = _pyodide;
            pyodide_init_done = true;
            console.log('[CMAB] Rule Setup Done', new Date());

            const event = new CustomEvent('cmabSetupComplete');
            window.dispatchEvent(event);
            eventBus.trigger(CoreEvents.CMAB_MANIFEST_LOADED, {manifest: manifest})

            sendStats(statServerUrl + '/event/' + experimentID, 'event', {
                'event': {
                    'type': 'pyodide_init_done',
                },
                'ts': new Date().getTime()
            });
        });

        eventBus.on(MediaPlayerEvents.BUFFER_LOADED, onBufferLoaded, instance);
        eventBus.on(MediaPlayerEvents.BUFFER_EMPTY, onBufferEmpty, instance);

        CMABController = CMABAbrController(context).create();
    }

    function onBufferEmpty(e) {
        if (e.mediaType === 'video') {
            if (lastStallTime != null && lastRebufferingBitrate != null) {
                let tic = new Date();
                console.log('[CMAB] Buffer Empty:', e, tic, currentBitrate);
                lastStallTime = new Date();
                lastRebufferingBitrate = currentBitrateKbps;
                rebufferingEvents.get(currentBitrateKbps).push(lastStallTime);
            }
        }
    }

    function onBufferLoaded(e) {
        if (e.mediaType === 'video') {
            let tic = new Date();
            console.log('[CMAB] Buffer Loaded:', e, tic, currentBitrate);

            if (lastStallTime != null && lastRebufferingBitrate != null) {
                let stall_started_at = rebufferingEvents.get(lastRebufferingBitrate).pop();
                let duration = (tic - stall_started_at) / 1000.0;
                rebufferingEvents.get(lastRebufferingBitrate).push(duration);
                console.log('[CMAB] Latest Rebuffering Duration:', duration);
                console.log('[CMAB] All Rebuffering Events:')
                cmabLog(rebufferingEvents);
            }
        }
    }

    function getMaxIndex(rulesContext) {
        try {
            let switchRequest = SwitchRequest(context).create();
            const abrController = rulesContext.getAbrController();
            const streamInfo = rulesContext.getStreamInfo();
            const scheduleController = rulesContext.getScheduleController();
            const playbackController = scheduleController.getPlaybackController();
            const isDynamic = streamInfo && streamInfo.manifestInfo ? streamInfo.manifestInfo.isDynamic : null;
            const mediaType = rulesContext.getMediaInfo().type;
            const bufferStateVO = dashMetrics.getCurrentBufferState(mediaType);
            const currentBufferLevel = playbackController.getBufferLevel();
            const playbackRate = playbackController.getPlaybackRate();
            const throughputHistory = abrController.getThroughputHistory();
            let throughput = throughputHistory.getSafeAverageThroughput(Constants.VIDEO, isDynamic);
            let currentLiveLatency = playbackController.getCurrentLiveLatency();
            let latencyTarget = playbackController.getLiveDelay();
            const mediaInfo = rulesContext.getMediaInfo();

            let now = new Date();
            bufferLevelHistory.push({
                now: now,
                bufferLevel: currentBufferLevel
            });

            // calculate bufferLevelMovingAverage from the latest 10 samples
            const movingAverageWindow = 10;
            bufferLevelMovingAverage = bufferLevelHistory.slice(-movingAverageWindow).reduce((acc, val) => acc + val.bufferLevel, 0) / movingAverageWindow;

            console.log('dashjs metrics: throughput', throughput, 'latency', currentLiveLatency, 'latency target', latencyTarget, 'buffer moving average', bufferLevelMovingAverage);

            if (!currentLiveLatency) {
                currentLiveLatency = 0;
            }

            // Use constant bitrate for audio
            if (mediaType === Constants.AUDIO) {
                audioCodec = mediaInfo.codec.split(';')[1].split('=')[1].replace(/['"]+/g, '');
                audioBitrate = mediaInfo.bitrateList[0].bandwidth / 1000.0;
            }

            if (isNaN(throughput) && mediaType === Constants.VIDEO) {
                console.log('[CMAB] Throughput is NaN');
                switchRequest.reason = 'initial request';
                switchRequest.quality = 1;
                switchRequest.priority = SwitchRequest.PRIORITY.STRONG;
                scheduleController.setTimeToLoadDelay(0);
                return switchRequest;
            }

            if (!bufferStateVO || mediaType === Constants.AUDIO ||
                abrController.getAbandonmentStateFor(streamInfo.id, mediaType) === MetricsConstants.ABANDON_LOAD) {

                return switchRequest;
            }

            let context = {
                video_codec: mediaInfo.codec.split(';')[1].split('=')[1].replace(/['"]+/g, ''),
                stream_id: streamInfo.index,
                seg_duration: streamInfo.manifestInfo.maxFragmentDuration,
                audio_codec: audioCodec,
                audio_bitrate: audioBitrate,
                target_latency: latencyTarget,
            };

            let bitrateList = mediaInfo.bitrateList; // [{bandwidth: 200000, width: 640, height: 360}, ...]
            if (cmabArms == null) {
                cmabArms = Array.apply(null, Array(bitrateList.length)).map(function (x, i) {
                    return i;
                })
            }

            // initialize a dictionary to store rebuffering events for each bitrate
            if (rebufferingEvents.size === 0) {
                for (let i = 0; i < bitrateList.length; i++ ) {
                    rebufferingEvents.set(bitrateList[i].bandwidth / 1000.0, []);
                }
            }

            let currentQualityLevel = abrController.getQualityFor(mediaType, streamInfo.id);
            currentBitrate = bitrateList[currentQualityLevel].bandwidth;
            currentBitrateKbps = currentBitrate / 1000.0;
            let maxBitrateKbps = bitrateList[bitrateList.length-1].bandwidth / 1000.0;

            let networkLatency = getLatestNetworkLatency();
            let sessionLatencyHistory = getLatencyHistory()
            let sessionThroughputHistory = getThroughputHistory()

            let current_decision_making_time = new Date();
            let current_timestamp = current_decision_making_time.getTime() / 1000.0;

            if (starlink_timeslot_count === 0) {
                starlink_timeslot_count += 1;
            } else {
                if (isSameSatelliteTimeSlot(previous_decision_making_time, current_decision_making_time)) {
                    console.log('timeslot: ', starlink_timeslot_count, ' now: ', current_decision_making_time);
                } else {
                    starlink_timeslot_count += 1;
                    console.log('timeslot: ', starlink_timeslot_count, ' now: ', current_decision_making_time);
                }
            }
            previous_decision_making_time = current_decision_making_time;

            throughput = parseFloat(throughput) / 1000.0;

            agent_context.push({
                tic: current_timestamp,
                timeslot_count: starlink_timeslot_count,
                throughput: throughput,
                network_latency: parseFloat(networkLatency),
                live_latency: parseFloat(currentLiveLatency),
                playback_rate: parseFloat(playbackRate)
            });

            // calculate weighted agent context
            let weighted_agent_context = [];

            // variance weight for latency
            let weight_var_latency = [];
            const rate = 100;
            let weight_time = [];
            const maxLatencyStd = Math.max(...sessionLatencyHistory.map(x => x.std));

            const theta = 0.1;
            for (let i = 0; i < agent_context.length; i++) {
                let matched = false;
                for (let j = 0; j < sessionLatencyHistory.length; j++) {
                    if (agent_context[i].tic >= sessionLatencyHistory[j].start && agent_context[i].tic < sessionLatencyHistory[j].end) {
                        if (sessionLatencyHistory[j].std === maxLatencyStd) {
                            weight_var_latency.push(theta);
                        } else {
                            weight_var_latency.push(1 - (sessionLatencyHistory[j].std / maxLatencyStd));
                        }
                        weight_time.push(Math.log((rate) * ((i+1) / sessionLatencyHistory.length)) / Math.log(rate));
                        matched = true;
                    }
                }
                if (!matched) {
                    weight_var_latency.push(1);
                    weight_time.push(1);
                }
            }

            console.log('weight_time length: ', weight_time.length, 'weight_var_latency length: ', weight_var_latency.length, 'agent_context length: ', agent_context.length);
            console.assert(weight_time.length === weight_var_latency.length);
            console.assert(weight_time.length === agent_context.length);

            cmabLog(weight_time)
            cmabLog(weight_var_latency)
            console.log('[CMAB] Waiting CMABController.getCMABNextQuality')

            for (let i = 0; i < agent_context.length; i++) {
                weighted_agent_context.push({
                    network_latency: weight_time[i] * weight_var_latency[i] * agent_context[i].network_latency,
                    throughput: weight_time[i] * weight_var_latency[i] * agent_context[i].throughput,
                    live_latency: agent_context[i].live_latency,
                    playback_rate: agent_context[i].playback_rate
                });
            }

            console.log('current round: ', agent_context.length, 'network latency: ', networkLatency, 'live latency: ', currentLiveLatency, 'throughput: ', throughput, 'playback rate: ', playbackRate);
            cmabLog(agent_context)
            cmabLog(weighted_agent_context)

            switchRequest.quality = CMABController.getCMABNextQuality(
                experimentID,
                pyodide,
                context,
                bitrateList,
                cmabArms,
                maxBitrateKbps,
                currentLiveLatency,
                rebufferingEvents,
                cmabAlpha,
                weighted_agent_context,
                start_time,
                bufferLevelMovingAverage,
                currentBufferLevel,
                playbackBufferMin
            );

            switchRequest.reason = 'Switch bitrate based on CMAB';
            switchRequest.priority = SwitchRequest.PRIORITY.STRONG;
            scheduleController.setTimeToLoadDelay(0);
            console.log('[CMAB] Switch Request:', switchRequest.quality)
            return switchRequest;
        } catch (e) {
            console.log(e);
            throw e;
        }
    }

    function reset() {
        eventBus.off(MediaPlayerEvents.BUFFER_LOADED, onBufferLoaded, instance);
        eventBus.off(MediaPlayerEvents.BUFFER_EMPTY, onBufferEmpty, instance);
    }


    instance = {
        getMaxIndex: getMaxIndex,
        reset: reset
    };

    setup();

    return instance;
}

CMABRule.__dashjs_factory_name = 'CMABRule';
export default FactoryMaker.getClassFactory(CMABRule);
