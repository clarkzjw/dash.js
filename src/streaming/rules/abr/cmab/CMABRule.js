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
import CMABQoeEvaluator from './CMABQoEEvaluator';
import CMABAbrController from './CMABAbrController';
import SwitchRequest from '../../SwitchRequest';

const { loadPyodide } = require('pyodide');

function CMABRule(config) {
    config = config || {};

    let dashMetrics = config.dashMetrics;
    let factory = dashjs.FactoryMaker;
    let SwitchRequest = factory.getClassFactoryByName('SwitchRequest');
    let MetricsModel = factory.getSingletonFactoryByName('MetricsModel');
    let StreamController = factory.getSingletonFactoryByName('StreamController');
    let context = this.context;
    let instance;

    let cmabArms = null;
    let cmabContext = null;
    let pyodide = null;
    let pyodide_init_done = false;

    let selectedArm;
    let qoeEvaluator;
    let CMABController;

    const setup = async () => {
        qoeEvaluator = CMABQoeEvaluator(context).create();
        CMABController = CMABAbrController(context).create();

        async function init_pyodide() {
            console.log('Loading Pyodide...');
            let pyodide = await loadPyodide({indexURL: 'http://127.0.0.1'});
            let requirements = [
                'pandas',
                'matplotlib',
                'numpy',
                'Pillow',
                'scikit-learn',
                'scipy',
                'http://127.0.0.1/mabwiser-2.7.0-py3-none-any.whl',
            ]
            await pyodide.loadPackage(requirements);
            return pyodide;
        }

        init_pyodide().then((pyodide_context) => {
            pyodide = pyodide_context;
            pyodide_init_done = true;
            console.log('CMAB Rule Setup Done', new Date());
        });
    }

    function getMaxIndex(rulesContext) {
        try {
            let switchRequest = SwitchRequest(context).create();
            const abrController = rulesContext.getAbrController();
            const streamInfo = rulesContext.getStreamInfo();
            const streamController = StreamController(context).getInstance();
            const scheduleController = rulesContext.getScheduleController();
            const playbackController = scheduleController.getPlaybackController();
            const isDynamic = streamInfo && streamInfo.manifestInfo ? streamInfo.manifestInfo.isDynamic : null;
            const mediaType = rulesContext.getMediaInfo().type;
            const bufferStateVO = dashMetrics.getCurrentBufferState(mediaType);

            if (mediaType === Constants.AUDIO || pyodide_init_done === false) {
                return switchRequest;
            }

            const mediaInfo = rulesContext.getMediaInfo();
            let bitrateList = mediaInfo.bitrateList; // [{bandwidth: 200000, width: 640, height: 360}, ...]
            console.log(bitrateList);
            console.log('number of arms', bitrateList.length);
            if (cmabArms == null) {
                console.log('cmabArms is null');
                cmabArms = Array.apply(null, Array(bitrateList.length)).map(function (x, i) { return 'arm'+i; })
            } else {
                console.log('cmabArms: ', cmabArms);
            }
            if (cmabContext == null) {
                console.log('cmabContext is null');
            }

            const playbackRate = playbackController.getPlaybackRate();
            const throughputHistory = abrController.getThroughputHistory();
            const throughput = throughputHistory.getSafeAverageThroughput(mediaType, isDynamic);

            let currentLatency = playbackController.getCurrentLiveLatency();
            if (!currentLatency) {
                currentLatency = 0;
            }

            console.log(`Throughput ${Math.round(throughput)} kbps, playback rate ${playbackRate}, current latency ${currentLatency}`);

            if (isNaN(throughput) || !bufferStateVO) {
                return switchRequest;
            }
            if (abrController.getAbandonmentStateFor(streamInfo.id, mediaType) === MetricsConstants.ABANDON_LOAD) {
                return switchRequest;
            }

            // QoE parameters

            // Learning rule pre-calculations

            // Dynamic Weights Selector (step 1/2: initialization)

            // Select next quality

            selectedArm = 'arm2';
            // selectedArm = pyodide.runPython(`
            //     from mabwiser.mab import MAB, LearningPolicy, NeighborhoodPolicy
            //
            //     # Data
            //     arms = ['Arm1', 'Arm2']
            //     decisions = ['Arm1', 'Arm1', 'Arm2', 'Arm1']
            //     rewards = [20, 17, 25, 9]
            //
            //     # Model
            //     mab = MAB(arms, LearningPolicy.UCB1(alpha=1.25))
            //
            //     # Train
            //     mab.fit(decisions, rewards)
            //
            //     # Test
            //     mab.predict()
            // `);

            console.log(selectedArm, new Date());

            let metricsModel = MetricsModel(context).getInstance();
            let metrics = metricsModel.getMetricsFor(mediaType, true);



            let current = abrController.getQualityFor(mediaType, streamController.getActiveStreamInfo().id);
            // If already in lowest bitrate, don't do anything
            if (current === 0) {
                return SwitchRequest(context).create();
            }

            switchRequest.quality = CMABController.getNextQuality();
            switchRequest.reason = 'Switch bitrate based on CMAB';
            switchRequest.priority = SwitchRequest.PRIORITY.STRONG;

            scheduleController.setTimeToLoadDelay(0);

            return switchRequest;

        } catch (e) {
            console.log(e);
            throw e;
        }
    }

    instance = {
        getMaxIndex: getMaxIndex
    };

    setup();

    return instance;
}

CMABRule.__dashjs_factory_name = 'CMABRule';
export default FactoryMaker.getClassFactory(CMABRule);
