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
import Settings from '../../../../core/Settings';

const { loadPyodide } = require('pyodide');
const statServerUrl = 'http://stat-server:8000';
const pyodideLoadingUrl = 'http://pyodide/pyodide/';

// const statServerUrl = 'http://100.99.201.63/stats';
// const pyodideLoadingUrl = 'http://100.99.201.63/pyodide/';

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

function getLatencyHistory() {
    const url = statServerUrl + '/pingstats';
    return getHistory(url);
}

function getThroughputHistory() {
    const url = statServerUrl + '/throughputstats';
    return getHistory(url);
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

async function sendStats(url, stat) {
    fetch(url, {
        credentials: 'omit',
        mode: 'cors',
        method: 'post',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stat })
    })
        .then(resp => {
            if (resp.status === 200) {
                return resp.json()
            } else {
                console.log('Status: ' + resp.status)
                return Promise.reject('500')
            }
        })
        .catch(err => {
            if (err === '500') return
            console.log(err)
        })
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
    let pyodideInitDone = false;

    let CMABController;
    let player_settings;

    let audioCodec = 'aaclc';
    let audioBitrate = -1;
    let currentBitrate;
    let currentBitrateKbps;
    let lastStallTime = null;
    let rebufferingEvents = new Map();
    let cmabAlpha = null;

    let _py_import_test = `
    import pandas as pd
    from mabwiser.mab import MAB, LearningPolicy, NeighborhoodPolicy
    from sklearn.preprocessing import StandardScaler
    from pprint import pprint
    `

    let history = [];

    async function init_pyodide() {
        console.log('[CMAB] Loading Pyodide...');
        let pyodide = await loadPyodide({ indexURL: pyodideLoadingUrl });
        let requirements = [
            'pandas',
            'scikit-learn',
            pyodideLoadingUrl + 'mabwiser-2.7.0-py3-none-any.whl',
            pyodideLoadingUrl + 'itu_p1203-1.9.5-py3-none-any.whl',
        ]
        await pyodide.loadPackage(requirements);
        await pyodide.runPythonAsync(_py_import_test);

        return pyodide;
    }

    function setup() {
        player_settings = Settings(context).getInstance()
        cmabAlpha = player_settings.get().streaming.abr.cmab.alpha;

        init_pyodide().then((pyodide_context) => {
            pyodide = pyodide_context;
            console.log('[CMAB] Rule Setup Done', new Date());
            pyodideInitDone = true;

            sendStats(statServerUrl + '/event/initDone', {
                'initDone': 1,
            });

            eventBus.on(MediaPlayerEvents.BUFFER_LOADED, onBufferLoaded, instance);
            eventBus.on(MediaPlayerEvents.BUFFER_EMPTY, onBufferEmpty, instance);

            CMABController = CMABAbrController(context).create();
        });
    }

    function onBufferEmpty(e) {
        if (e.mediaType === 'video' && pyodideInitDone === true) {
            let tic = new Date();
            console.log('[CMAB] Buffer Empty:', e, tic, currentBitrate);
            lastStallTime = new Date();
        }
    }

    function onBufferLoaded(e) {
        if (e.mediaType === 'video' && pyodideInitDone === true) {
            let tic = new Date();
            console.log('[CMAB] Buffer Loaded:', e, tic, currentBitrate);
            if (lastStallTime != null) {
                let duration = (tic - lastStallTime) / 1000.0;
                rebufferingEvents.get(currentBitrateKbps).push(duration);
                console.log('[CMAB] Latest Rebuffering Duration:', duration);
                console.log('[CMAB] All Rebuffering Events:', rebufferingEvents);
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
            const playbackRate = playbackController.getPlaybackRate();
            const throughputHistory = abrController.getThroughputHistory();
            const throughput = throughputHistory.getSafeAverageThroughput(mediaType, isDynamic);
            let currentLiveLatency = playbackController.getCurrentLiveLatency();
            let latencyTarget = playbackController.getLiveDelay();
            const mediaInfo = rulesContext.getMediaInfo();

            if (!currentLiveLatency) {
                currentLiveLatency = 0;
            }

            // Use constant bitrate for audio
            if (mediaType === Constants.AUDIO) {
                audioCodec = mediaInfo.codec.split(';')[1].split('=')[1].replace(/['"]+/g, '');
                audioBitrate = mediaInfo.bitrateList[0].bandwidth / 1000.0;
            }

            if (isNaN(throughput) ||
                !bufferStateVO ||
                mediaType === Constants.AUDIO ||
                pyodideInitDone === false ||
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

            // initialize map to store rebuffering events for different bitrate levels
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

            history.push({
                'latency': networkLatency,
                'latency_history': sessionLatencyHistory,
                'throughput_history': sessionThroughputHistory,
                'timestamp': new Date()
            });

            let pingHistory = sessionLatencyHistory["ping_history"];
            // let lastFivePings = pingHistory.slice(-5);
            let pingMean = pingHistory.map(x => x.mean);
            let pingStd = pingHistory.map(x => x.std);

            console.log('[CMAB] Waiting CMABController.getCMABNextQuality')
            switchRequest.quality = CMABController.getCMABNextQuality(
                pyodide,
                context,
                bitrateList,
                cmabArms,
                currentQualityLevel,
                currentBitrateKbps,
                maxBitrateKbps,
                currentLiveLatency,
                playbackRate,
                throughput,
                rebufferingEvents,
                cmabAlpha,
                pyodideInitDone,
                networkLatency,
                sessionLatencyHistory,
                sessionThroughputHistory,
                pingMean,
                pingStd,
            );
            switchRequest.reason = 'Switch bitrate based on CMAB';
            switchRequest.priority = SwitchRequest.PRIORITY.STRONG;

            scheduleController.setTimeToLoadDelay(0);

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
