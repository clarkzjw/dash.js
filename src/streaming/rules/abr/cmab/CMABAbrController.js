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

const statServerUrl = 'http://stat-server:8000';
// const statServerUrl = 'http://100.99.201.63/stats';

function getLatestNetworkLatency() {
    let LatencySidecarURL = statServerUrl+'/ping';

    const xhr = new XMLHttpRequest();
    xhr.open('GET', LatencySidecarURL, false);
    xhr.send(null);
    if (xhr.status === 200) {
        return xhr.responseText;
    } else {
        throw new Error('Request failed: ' + xhr.statusText);
    }
}

function getHistory(url) {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, false); // 'false' makes the request synchronous
    xhr.setRequestHeader('Content-Type', 'application/json');

    try {
        xhr.send(null);

        if (xhr.status === 200) {
            return JSON.parse(xhr.responseText); // Return parsed JSON
        } else {
            // console.log("Error: " + xhr.status);
            return null; // Handle non-200 responses
        }
    } catch (err) {
        // console.log("Request failed", err);
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

async function sendStats(url, type, stat) {
    fetch(url, {
        credentials: 'omit',
        mode: 'cors',
        method: 'post',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({type: stat})
    })
        .then(resp => {
            if (resp.status === 200) {
                // console.log('Sent %s', type)
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

function CMABAbrController() {
    let _py_mabwiser_select_arm = `
    import pandas as pd
    from mabwiser.mab import MAB, LearningPolicy, NeighborhoodPolicy
    from sklearn.preprocessing import StandardScaler
    from pprint import pprint

    from js import js_cmabArms, js_rewards, js_selected_arms, js_bitrate, js_history, js_rebuffer_events, js_cmabAlpha
    from js import js_throughput_playback_history, js_latency_playback_history

    arms = js_cmabArms.to_py()
    rewards = js_rewards.to_py()
    selected_arms = js_selected_arms.to_py()
    bitrate = js_bitrate.to_py()
    history = js_history.to_py()
    rebuffering_events = js_rebuffer_events.to_py()
    cmab_alpha = js_cmabAlpha
    length = len(history)
    throughput_playback_history = js_throughput_playback_history.to_py()
    latency_playback_history = js_latency_playback_history.to_py()

    print("cmab_alpha from pyodide", cmab_alpha)
    pprint(throughput_playback_history)
    pprint(latency_playback_history)

    # selected_arms == bitrate level in each round
    previous_rounds = length - 1

    throughput = [x['throughput'] for x in history]
    playback_rate = [x['playback_rate'] for x in history]
    network_latency = [x['network_latency'] for x in history]
    live_latency = [x['live_latency'] for x in history]

    #print('history length', length)
    #print('selected_arms length', len(selected_arms))
    #print('rewards length', len(rewards))
    #print('bitrate length', len(bitrate))
    #print('throughput length', len(throughput))

    train_df = pd.DataFrame({
                             'selected_arms': selected_arms,
                             'reward': rewards,
                             'bitrate': bitrate,
                             'throughput': throughput[:previous_rounds],
                             'playback_rate': playback_rate[:previous_rounds],
                             'network_latency': network_latency[:previous_rounds],
                             'live_latency': live_latency[:previous_rounds],
                            #  'live_latency': live_latency[length:previous_rounds],
                            #  'throughput': throughput[length:previous_rounds],
                            #  'playback_rate': playback_rate[length:previous_rounds]
                             })

    #pprint(train_df)

    scaler = StandardScaler()
    train = scaler.fit_transform(train_df[[
        'throughput',
        'playback_rate',
        'network_latency'
    ]])

    # Model

    # LinUCB
    # mab = MAB(arms=arms, learning_policy=LearningPolicy.LinUCB(alpha=1.25, l2_lambda=1))
    # mab.fit(decisions=train_df['selected_arms'], rewards=train_df['reward'], contexts=train)

    # EpsilonGreedy
    # mab = MAB(arms=arms, learning_policy=LearningPolicy.EpsilonGreedy(epsilon=0.25))
    # mab.fit(decisions=train_df['selected_arms'], rewards=train_df['reward'])

    # LinTS
    mab = MAB(arms=arms, learning_policy=LearningPolicy.LinTS(alpha=cmab_alpha))
    mab.fit(decisions=train_df['selected_arms'], rewards=train_df['reward'], contexts=train)

    # Test
    test_df = pd.DataFrame({
                            'throughput': [throughput[-1]],
                            'playback_rate': [playback_rate[-1]],
                            'network_latency': [network_latency[-1]]
                            })
    test = scaler.transform(test_df)

    mab.predict(test)
    `;

    let _py_itu_p1203_calculate_o46 = `
    import json
    from itu_p1203 import P1203Standalone
    from js import js_itup1203inputjson

    input_json = js_itup1203inputjson.to_py()

    input = json.loads(json.dumps(input_json))
    res = P1203Standalone(input).calculate_complete()
    res["O46"]
    `;

    let instance;

    let starlinkTimeslotCount = 0;

    let _rewardsArray = [];
    let _selectedArmsArray = [];
    let _bitrateArray = [];

    let _throughputDict = new Map();

    let rounds = 0;

    function timeDiff(tic, toc) {
        return (toc - tic) / 1000.0;
    }

    // calculate reward using QoE ITU-T Rec. P.1203: https://github.com/itu-p1203/itu-p1203
    function calculateReward(pyodide, context, currentLatency, selectedBitrate, bitrateRatio, rebufferingEvents) {
        let itu_p1203_input_json = generateITUP1203InputJSON(context);
        // console.log('calculateReward context', context, 'target live delay', context.target_latency);

        let total_rebuffering_time = 0;
        let selected_bitrate_rebuffering_time = 0;
        let rebuffering_ratio = 0;

        for (const entry of rebufferingEvents.entries()) {
            let bitrate = entry[0];
            let event = entry[1];
            let sum = 0;
            if (event.length > 0) {
                sum = event.reduce((a,b)=>a+b);
            }
            if (bitrate === selectedBitrate) {
                selected_bitrate_rebuffering_time = sum;
            }
            total_rebuffering_time = total_rebuffering_time + sum;
            // console.log(`entry ${entry}, sum ${sum}, bitrate ${bitrate}`);
        }

        if (total_rebuffering_time > 0) {
            rebuffering_ratio = selected_bitrate_rebuffering_time / total_rebuffering_time;
        }
        // console.log(`total rebuffering ${total_rebuffering_time}, selected rebuffering ${selected_bitrate_rebuffering_time}, ratio ${rebuffering_ratio}`);

        let itu_qoe = calculateITUP1203QoE(pyodide, itu_p1203_input_json);
        let qoe = itu_qoe * (context.target_latency / currentLatency) * bitrateRatio - rebuffering_ratio;

        console.log(`ITU P1203 QoE: ${itu_qoe}, qoe: ${qoe}, current latency: ${currentLatency}`);
        return qoe;
    }

    // generate ITU P1203 input json, using mode 0
    // https://github.com/itu-p1203/itu-p1203/blob/master/examples/mode0.json
    function generateITUP1203InputJSON(context) {
        // example input json
        // {
        //     "I11": {
        //         "segments": [
        //             {
        //                 "bitrate": 331.46,
        //                 "codec": "aaclc",
        //                 "duration": 1,
        //                 "start": 10
        //             }
        //         ],
        //         "streamId": 42
        //     },
        //     "I13": {
        //         "segments": [
        //             {
        //                 "bitrate": 691.72,
        //                 "codec": "h264",
        //                 "duration": 1,
        //                 "fps": 24.0,
        //                 "resolution": "1920x1080",
        //                 "start": 10
        //             }
        //         ],
        //         "streamId": 42
        //     },
        //     "I23": {
        //         "stalling": [],
        //         "streamId": 42
        //     },
        //     "IGen": {
        //         "device": "pc",
        //         "displaySize": "1920x1080",
        //         "viewingDistance": "150cm"
        //     }
        // }

        let audio_bitrate = context.audio_bitrate;
        let audio_codec = context.audio_codec.includes('mp4a') ? 'aaclc' : context.audio_codec;
        let seg_duration = context.seg_duration;
        let stream_id = context.stream_id;

        let start = 0;
        let fps = 24.0;
        let video_bitrate = context.video_bitrate;
        let video_codec = context.video_codec.includes('avc') ? 'h264' : context.video_codec;
        let resolution = context.resolution;

        return {
            'I11': {
                'segments': [
                    {
                        'bitrate': audio_bitrate,
                        'codec': audio_codec,
                        'duration': seg_duration,
                        'start': start
                    }
                ],
                'streamId': stream_id
            },
            'I13': {
                'segments': [
                    {
                        'bitrate': video_bitrate,
                        'codec': video_codec,
                        'duration': seg_duration,
                        'fps': fps,
                        'resolution': resolution,
                        'start': start
                    }
                ],
                'streamId': stream_id
            },
            'I23': {
                'stalling': [],
                'streamId': stream_id
            },
            'IGen': {
                'device': 'pc',
                'displaySize': resolution,
                'viewingDistance': '150cm'
            }
        };
    }

    // calculate ITU P1203 O46 QoE value
    function calculateITUP1203QoE(pyodide, itup1203_input_json) {
        window.js_itup1203inputjson = itup1203_input_json;

        return pyodide.runPython(_py_itu_p1203_calculate_o46);
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
        }

        return false
    }

    function getCMABNextQuality(pyodide, context, bitrateList, cmabArms, currentQualityLevel,
        currentBitrateKbps, maxBitrateKbps, currentLiveLatency, playbackRate, throughput,
        rebufferingEvents, cmabAlpha, pyodideInitDone) {
        if (pyodideInitDone === false) {
            return 0;
        }

        let _latency_playback_history = getLatencyHistory()
        let _throughput_playback_history = getThroughputHistory()

        // console.log(_latency_playback_history)
        // console.log(_throughput_playback_history)
        let tic = new Date();

        console.log('\ngetCMABNextQuality', tic);
        // console.log(`Throughput ${throughput} kbps, playbackSpeed ${playbackRate}, currentLatency ${currentLiveLatency}, currentBitrate ${currentBitrateKbps}, maxBitrate ${maxBitrateKbps}, currentQualityLevel ${currentQualityLevel}`);

        throughput = throughput / 1000.0;

        if (_throughputDict.get(starlinkTimeslotCount) === undefined) {
            _throughputDict.set(starlinkTimeslotCount, {
                'start': tic,
                'history': []
            });
        } else {
            let last_timeslot_started_at = _throughputDict.get(starlinkTimeslotCount)['start']
            let same_timeslot = isSameSatelliteTimeSlot(last_timeslot_started_at, tic);

            if (!same_timeslot) {
                starlinkTimeslotCount += 1
                _throughputDict.set(starlinkTimeslotCount, {
                    'start': tic,
                    'history': [],
                });
                _selectedArmsArray = [];
                _rewardsArray = [];
                _bitrateArray = [];
            }
        }

        let selectedArm = 0;
        let networkLatency = getLatestNetworkLatency();

        _throughputDict.get(starlinkTimeslotCount).history.push({
            tic: tic,
            throughput: throughput,
            network_latency: networkLatency,
            live_latency: currentLiveLatency,
            playback_rate: playbackRate
        });
        // console.log('network latency:', networkLatency);

        window.js_cmabArms = cmabArms;
        window.js_rewards = _rewardsArray;
        window.js_selected_arms = _selectedArmsArray;
        window.js_bitrate = _bitrateArray;
        window.js_history = _throughputDict.get(starlinkTimeslotCount).history;
        window.js_rebuffer_events = rebufferingEvents;
        window.js_cmabAlpha = cmabAlpha;
        window.js_throughput_playback_history = _throughput_playback_history;
        window.js_latency_playback_history = _latency_playback_history;

        // just recovered from satellite handover
        if (_selectedArmsArray.length < cmabArms.length - 1) {
            console.log('length: ', _selectedArmsArray.length)
            selectedArm = cmabArms.length - 1
        } else {
            selectedArm = pyodide.runPython(_py_mabwiser_select_arm);
        }

        _selectedArmsArray.push(selectedArm);

        context.video_bitrate = bitrateList[selectedArm].bandwidth / 1000.0;
        context.resolution = `${bitrateList[selectedArm].width}x${bitrateList[selectedArm].height}`;

        let bitrateRatio = context.video_bitrate / maxBitrateKbps;
        let reward_qoe = calculateReward(pyodide, context, currentLiveLatency, context.video_bitrate, bitrateRatio, rebufferingEvents);

        _bitrateArray.push(context.video_bitrate);
        _rewardsArray.push(reward_qoe);

        sendStats(statServerUrl+'/qoe/', 'qoe', {
            timestamp: new Date().valueOf(),
            reward_qoe: reward_qoe,
            arm: selectedArm,
            video_bitrate: context.video_bitrate,
            bitrateRatio: bitrateRatio,
            currentLiveLatency: currentLiveLatency,
        });

        rounds = rounds + 1;

        let toc = new Date();
        console.log('selected arm', selectedArm, 'time used' , timeDiff(tic, toc), 'seconds');
        return selectedArm;
    }

    instance = {
        getCMABNextQuality,
    };

    return instance;
}

CMABAbrController.__dashjs_factory_name = 'CMABAbrController';
export default FactoryMaker.getClassFactory(CMABAbrController);
