import FactoryMaker from '../../../../core/FactoryMaker';

function CMABAbrController() {
    let mabwiser_select_arm = `
    import pandas as pd
    from mabwiser.mab import MAB, LearningPolicy, NeighborhoodPolicy
    from sklearn.preprocessing import StandardScaler
    from pprint import pprint

    from js import js_cmabArms, js_rewards, js_selected_arms, js_live_latencies, js_throughput, js_playback_rates

    arms = js_cmabArms.to_py()
    rewards = js_rewards.to_py()
    selected_arms = js_selected_arms.to_py()
    live_latency = js_live_latencies.to_py()
    throughput = js_throughput.to_py()
    playback_rate = js_playback_rates.to_py()

    # selected_arms == bitrate level in each round
    previous_rounds = len(live_latency) - 1

    train_df = pd.DataFrame({
                             'selected_arms': selected_arms,
                             'reward': rewards,
                             'live_latency': live_latency[:previous_rounds],
                             'throughput': throughput[:previous_rounds],
                             'playback_rate': playback_rate[:previous_rounds]
                             })

    pprint(train_df)

    scaler = StandardScaler()
    train = scaler.fit_transform(train_df[['live_latency', 'throughput', 'playback_rate']])

    # Model
    mab = MAB(arms=arms, learning_policy=LearningPolicy.LinUCB(alpha=1.25, l2_lambda=1))

    # Train
    mab.fit(decisions=train_df['selected_arms'], rewards=train_df['reward'], contexts=train)

    # Test
    test_df = pd.DataFrame({
                            'live_latency': [live_latency[-1]],
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

    input = json.loads(input_json)
    res = P1203Standalone(input).calculate_complete()
    print(res["O46"])
    `;

    let instance;
    let selectedArm;
    let _mab_model;

    let _rewards_array = [];
    let _selected_arms = [];
    let _live_latency_array = [];
    let _throughput_array = [];
    let _playback_rate_array = [];

    let rounds = 0;

    function timediff(tic, toc) {
        return (toc - tic) / 1000.0;
    }

    // TODO
    // calculate reward using QoE ITU-T Rec. P.1203: https://github.com/itu-p1203/itu-p1203
    function calculateReward(currentLatency, throughput, playbackRate) {
        let itu_p1203_input_json = generateITUP1203InputJSON();
        return calculateITUP1203QoE(itu_p1203_input_json);
    }

    // TODO
    // generate ITU P1203 input json, mode0
    // https://github.com/itu-p1203/itu-p1203/blob/master/examples/mode0.json
    function generateITUP1203InputJSON() {
        return {};
    }

    // calculate ITU P1203 O46 QoE value
    function calculateITUP1203QoE(pyodide, itup1203_input_json) {
        window.js_itup1203inputjson = itup1203_input_json;

        return pyodide.runPython(itu_p1203_calculate_o46);
    }

    function getCMABNextQuality(pyodide, cmabArms, currentQualityLevel, currentLatency, playbackRate, throughput, metrics) {
        let tic = new Date();

        console.log('getCMABNextQuality', tic);
        console.log(`Throughput ${throughput} kbps, playback rate ${playbackRate}, current latency ${currentLatency}`);

        _live_latency_array.push(currentLatency);
        _throughput_array.push(throughput);
        _playback_rate_array.push(playbackRate);

        console.log('_selected_arms', _selected_arms);
        if (rounds === 0) {
            _selected_arms.push(cmabArms[0]);
            _rewards_array.push(calculateReward(currentLatency, throughput, playbackRate));
        } else {
            window.js_cmabArms = cmabArms;
            window.js_live_latencies = _live_latency_array;
            window.js_throughput = _throughput_array;
            window.js_rewards = _rewards_array;
            window.js_selected_arms = _selected_arms;
            window.js_playback_rates = _playback_rate_array;

            selectedArm = pyodide.runPython(mabwiser_select_arm);
            _selected_arms.push(selectedArm);
            _rewards_array.push(calculateReward(currentLatency, throughput, playbackRate));
        }

        let toc = new Date();
        rounds = rounds + 1;

        console.log(selectedArm, 'time used' , timediff(tic, toc), 'seconds');

        return 0;
    }

    instance = {
        getCMABNextQuality,
    };

    return instance;
}

CMABAbrController.__dashjs_factory_name = 'CMABAbrController';
export default FactoryMaker.getClassFactory(CMABAbrController);
