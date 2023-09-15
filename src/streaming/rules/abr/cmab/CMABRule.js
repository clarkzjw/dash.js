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

const { loadPyodide } = require('pyodide');

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

    let audioCodec = 'aaclc';
    let audioBitrate = -1;
    let currentBitrate;
    let lastStallTime = null;
    let rebufferingEvents = new Map();

    const setup = async () => {
        CMABController = CMABAbrController(context).create();

        async function init_pyodide() {
            console.log('Loading Pyodide...');
            let pyodide = await loadPyodide({indexURL: 'http://pyodide/pyodide/'});
            let requirements = [
                'pandas',
                'matplotlib',
                'numpy',
                'Pillow',
                'scikit-learn',
                'scipy',
                'http://pyodide/pyodide/mabwiser-2.7.0-py3-none-any.whl',
                'http://pyodide/pyodide/itu_p1203-1.9.5-py3-none-any.whl',
            ]
            await pyodide.loadPackage(requirements);
            return pyodide;
        }

        init_pyodide().then((pyodide_context) => {
            pyodide = pyodide_context;
            pyodide.runPython(`from mabwiser.mab import MAB`);
            pyodideInitDone = true;
            console.log('CMAB Rule Setup Done', new Date());
        });

        eventBus.on(MediaPlayerEvents.BUFFER_LOADED, onBufferLoaded, instance);
        eventBus.on(MediaPlayerEvents.BUFFER_EMPTY, onBufferEmpty, instance);
    }

    function onBufferEmpty(e) {
        if (e.mediaType === 'video' && pyodideInitDone === true) {
            let tic = new Date();
            console.log('===CMAB Buffer Empty:', e, currentBitrate, tic);
            lastStallTime = new Date();
        }
    }

    function onBufferLoaded(e) {
        if (e.mediaType === 'video' && pyodideInitDone === true) {
            let tic = new Date();
            console.log('===CMAB Buffer Loaded:', e, tic, lastStallTime);
            if (lastStallTime != null) {
                let duration = (tic - lastStallTime) / 1000.0;
                rebufferingEvents.get(currentBitrate).push(duration);
                console.log('++++rebuffering duration', rebufferingEvents);
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
            if (rebufferingEvents.size === 0) {
                for (let i = 0; i < bitrateList.length; i++ ) {
                    rebufferingEvents.set(bitrateList[i].bandwidth, []);
                }
            }

            let currentQualityLevel = abrController.getQualityFor(mediaType, streamInfo.id);
            currentBitrate = bitrateList[currentQualityLevel].bandwidth;
            let currentBitrateKbps = currentBitrate / 1000.0;
            let maxBitrateKbps = bitrateList[bitrateList.length-1].bandwidth / 1000.0;

            switchRequest.quality = CMABController.getCMABNextQuality(pyodide, context, bitrateList, cmabArms,
                currentQualityLevel, currentBitrateKbps, maxBitrateKbps,
                currentLiveLatency, playbackRate,
                throughput,
                rebufferingEvents);
            switchRequest.reason = 'Switch bitrate based on CMAB';
            switchRequest.priority = SwitchRequest.PRIORITY.STRONG;

            scheduleController.setTimeToLoadDelay(1.0);

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
