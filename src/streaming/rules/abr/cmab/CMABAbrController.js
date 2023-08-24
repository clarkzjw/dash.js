import FactoryMaker from '../../../../core/FactoryMaker';

function CMABAbrController() {
    let mabwiser_select_arm = `
    import pandas as pd
    from mabwiser.mab import MAB, LearningPolicy, NeighborhoodPolicy
    from sklearn.preprocessing import StandardScaler
    from pprint import pprint

    from js import js_cmabArms, js_rewards, js_selected_arms, js_live_latencies, js_throughput, js_playback_rates, js_bitrate

    arms = js_cmabArms.to_py()
    rewards = js_rewards.to_py()
    selected_arms = js_selected_arms.to_py()
    live_latency = js_live_latencies.to_py()
    throughput = js_throughput.to_py()
    playback_rate = js_playback_rates.to_py()
    bitrate = js_bitrate.to_py()

    # selected_arms == bitrate level in each round
    previous_rounds = len(live_latency) - 1

    length = len(selected_arms) // 2
    train_df = pd.DataFrame({
                             'selected_arms': selected_arms[length:],
                             'reward': rewards[length:],
                             'bitrate': bitrate[length:],
                             'live_latency': live_latency[length:previous_rounds],
                             'throughput': throughput[length:previous_rounds],
                             'playback_rate': playback_rate[length:previous_rounds]
                             })

    pprint(train_df)

    scaler = StandardScaler()
    train = scaler.fit_transform(train_df[[
        'throughput',
        'playback_rate'
    ]])

    # Model

    # LinUCB
    # mab = MAB(arms=arms, learning_policy=LearningPolicy.LinUCB(alpha=1.25, l2_lambda=1))
    # mab.fit(decisions=train_df['selected_arms'], rewards=train_df['reward'], contexts=train)

    # EpsilonGreedy
    # mab = MAB(arms=arms, learning_policy=LearningPolicy.EpsilonGreedy(epsilon=0.25))
    # mab.fit(decisions=train_df['selected_arms'], rewards=train_df['reward'])

    # LinTS
    mab = MAB(arms=arms, learning_policy=LearningPolicy.LinTS(alpha=0.25))
    mab.fit(decisions=train_df['selected_arms'], rewards=train_df['reward'], contexts=train)

    # Test
    test_df = pd.DataFrame({
                            'throughput': [throughput[-1]],
                            'playback_rate': [playback_rate[-1]]
                            })
    test = scaler.transform(test_df)

    mab.predict(test)
    `;

    let itu_p1203_calculate_o46 = `
    import json
    from itu_p1203 import P1203Standalone
    from js import js_itup1203inputjson

    input_json = js_itup1203inputjson.to_py()
    print(input_json);

    input = json.loads(json.dumps(input_json))
    res = P1203Standalone(input).calculate_complete()
    res["O46"]
    `;

    let instance;
    let selectedArm;
    let _mab_model;

    let starlink_timeslot_count = 0;

    let _rewards_array = [];
    let _selected_arms = [];
    let _live_latency_array = [];
    let _bitrate_array = [];

    let _throughput_array = [];
    let _throughput_dict = new Map();


    let _playback_rate_array = [];

    let rounds = 0;

    function timediff(tic, toc) {
        return (toc - tic) / 1000.0;
    }

    // calculate reward using QoE ITU-T Rec. P.1203: https://github.com/itu-p1203/itu-p1203
    function calculateReward(pyodide, context, currentLatency, throughput, playbackRate) {
        let itu_p1203_input_json = generateITUP1203InputJSON(context);
        console.log('calculateReward context', context, 'target live delay', context.target_latency);

        let itu_qoe = calculateITUP1203QoE(pyodide, itu_p1203_input_json);

        let qoe = itu_qoe * (context.target_latency / currentLatency);

        console.log(`ITU P1203 QoE: ${itu_qoe}, qoe: ${qoe}, current latency: ${currentLatency}`);
        return qoe;
    }

    function getNetworkLatency(host) {
        // fetch(url, {
        //     credentials: 'omit',
        //     mode: 'cors',
        //     method: 'post',
        //     headers: { 'Content-Type': 'application/json' },
        //     body: JSON.stringify({type: stat})
        // })
        //     .then(resp => {
        //         if (resp.status === 200) {
        //             console.log('Sent %d %s', stat.length, type)
        //             return resp.json()
        //         } else {
        //             console.log('Status: ' + resp.status)
        //             return Promise.reject('500')
        //         }
        //     })
        //     .catch(err => {
        //         if (err === '500') return
        //         console.log(err)
        //     })
        return 0;
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

        return pyodide.runPython(itu_p1203_calculate_o46);
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

    function getCMABNextQuality(pyodide, context, bitrateList, cmabArms, currentQualityLevel, currentLatency, playbackRate, throughput, metrics) {

        let tic = new Date();

        console.log('getCMABNextQuality', tic);
        console.log(`Throughput ${throughput} kbps, playback rate ${playbackRate}, current latency ${currentLatency}`);

        throughput = throughput / 1000.0;

        console.log(_throughput_dict.get(starlink_timeslot_count))
        console.log(_throughput_dict.get(starlink_timeslot_count) === undefined)

        if (_throughput_dict.get(starlink_timeslot_count) === undefined) {
            _throughput_dict.set(starlink_timeslot_count, {
                'start': tic,
                'history': []
            });
        } else {
            let last_timeslot_started_at = _throughput_dict.get(starlink_timeslot_count)['start']
            let same_timeslot = isSameSatelliteTimeSlot(last_timeslot_started_at, tic);
            console.log(last_timeslot_started_at, tic, same_timeslot);

            if (!same_timeslot) {
                starlink_timeslot_count += 1
                _throughput_dict.set(starlink_timeslot_count, {
                    'start': tic,
                    'history': []
                });
            }
        }

        let network_latency = getNetworkLatency();
        _throughput_dict.get(starlink_timeslot_count)['history'].push({
            tic: tic,
            throughput: throughput,
            network_latency: network_latency,
        });

        console.log(_throughput_dict)

        _live_latency_array.push(currentLatency);
        _throughput_array.push(throughput);
        _playback_rate_array.push(playbackRate);

        let selectedArm = 0;

        if (rounds < cmabArms.length) {
            selectedArm = rounds;
        } else {
            window.js_cmabArms = cmabArms;
            window.js_live_latencies = _live_latency_array;
            window.js_throughput = _throughput_array;
            window.js_rewards = _rewards_array;
            window.js_selected_arms = _selected_arms;
            window.js_playback_rates = _playback_rate_array;
            window.js_bitrate = _bitrate_array;

            selectedArm = pyodide.runPython(mabwiser_select_arm);
        }
        _selected_arms.push(selectedArm);

        context.video_bitrate = bitrateList[selectedArm].bandwidth / 1000.0;
        context.resolution = `${bitrateList[selectedArm].width}x${bitrateList[selectedArm].height}`;

        _bitrate_array.push(context.video_bitrate);
        _rewards_array.push(calculateReward(pyodide, context, currentLatency, throughput, playbackRate));

        let toc = new Date();
        rounds = rounds + 1;

        console.log('selected arm', selectedArm, 'time used' , timediff(tic, toc), 'seconds');

        return selectedArm;
    }

    instance = {
        getCMABNextQuality,
    };

    return instance;
}

CMABAbrController.__dashjs_factory_name = 'CMABAbrController';
export default FactoryMaker.getClassFactory(CMABAbrController);
