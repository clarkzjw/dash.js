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

let CMABRule;

// Rule that selects the lowest possible bitrate
function CMABRuleClass(config) {

    config = config || {};

    let factory = dashjs.FactoryMaker;
    let SwitchRequest = factory.getClassFactoryByName('SwitchRequest');
    let MetricsModel = factory.getSingletonFactoryByName('MetricsModel');
    let StreamController = factory.getSingletonFactoryByName('StreamController');
    let context = this.context;
    let instance;

    let pyodide = config.pyodide;
    let cmabArms = config.arms;
    let cmabContext = config.context;

    var result;

    const setup = async () => {
        console.log('CMAB Rule Setup Done', new Date());
    }

    function getMaxIndex(rulesContext) {
        try {
            let switchRequest = SwitchRequest(context).create();
            let mediaType = rulesContext.getMediaInfo().type;
            if (mediaType === 'audio') {
                return switchRequest;
            }

            const mediaInfo = rulesContext.getMediaInfo();
            let bitrateList = mediaInfo.bitrateList; // [{bandwidth: 200000, width: 640, height: 360}, ...]
            console.log(bitrateList);
            console.log('number of arms', bitrateList.length);
            if (cmabArms == null) {
                console.log('cmabArms is null');
                cmabArms = Array.apply(null, Array(bitrateList.length)).map(function (x, i) { return "arm"+i; })
            } else {
                console.log('cmabArms: ', cmabArms);
            }
            if (cmabContext == null) {
                console.log('cmabContext is null');
            }

            console.log('from CMABRuleClass getMaxIndex', new Date());

            result = pyodide.runPython(`
                from mabwiser.mab import MAB, LearningPolicy, NeighborhoodPolicy

                # Data
                arms = ['Arm1', 'Arm2']
                decisions = ['Arm1', 'Arm1', 'Arm2', 'Arm1']
                rewards = [20, 17, 25, 9]

                # Model
                mab = MAB(arms, LearningPolicy.UCB1(alpha=1.25))

                # Train
                mab.fit(decisions, rewards)

                # Test
                mab.predict()
            `);

            console.log(result, new Date());

            // here you can get some information about metrics for example, to implement the rule
            let metricsModel = MetricsModel(context).getInstance();
            var metrics = metricsModel.getMetricsFor(mediaType, true);

            // A smarter (real) rule could need analyze playback metrics to take
            // bitrate switching decision. Printing metrics here as a reference
            // console.log(metrics);

            // Get current bitrate
            let streamController = StreamController(context).getInstance();
            let abrController = rulesContext.getAbrController();
            let current = abrController.getQualityFor(mediaType, streamController.getActiveStreamInfo().id);

            // If already in lowest bitrate, don't do anything
            if (current === 0) {
                return SwitchRequest(context).create();
            }

            // Ask to switch to the lowest bitrate
            switchRequest.quality = 0;
            switchRequest.reason = 'Switch bitrate based on CMAB';
            switchRequest.priority = SwitchRequest.PRIORITY.STRONG;
            return switchRequest;

        } catch (e) {
            throw e;
        }

    }

    instance = {
        getMaxIndex: getMaxIndex
    };

    setup();

    return instance;
}

CMABRuleClass.__dashjs_factory_name = 'CMABRule';
CMABRule = dashjs.FactoryMaker.getClassFactory(CMABRuleClass);
