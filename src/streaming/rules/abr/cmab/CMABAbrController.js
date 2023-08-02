import FactoryMaker from '../../../../core/FactoryMaker';

function CMABAbrController() {
    let instance;
    let selectedArm;

    let _context;
    let _rewards;
    let _decisions;
    let _mab_model;

    let rounds = 0;

    function timediff(tic, toc) {
        return (toc - tic) / 1000.0;
    }

    function getCMABNextQuality(pyodide, cmabArms, currentQualityLevel, currentLatency, playbackRate, throughput, metrics) {
        rounds = rounds + 1;

        let tic = new Date();

        console.log(`cmabArms ${cmabArms}`);
        console.log(`Throughput ${Math.round(throughput)} kbps, playback rate ${playbackRate}, current latency ${currentLatency}`);
        console.log('getCMABNextQuality', tic);

        window.js_cmabArms = cmabArms;
        window.js_cmabContext = _context;
        window.js_currentQualityLevel = currentQualityLevel;
        window.js_currentLatency = currentLatency;
        window.js_playbackRate = playbackRate;
        window.js_throughput = throughput;
        window.js_rewards = _rewards;
        window.js_decisions = _decisions;

        selectedArm = pyodide.runPython(`
            from mabwiser.mab import MAB, LearningPolicy, NeighborhoodPolicy
            from js import js_cmabArms, js_rewards, js_decisions

            arms = js_cmabArms.to_py()
            rewards = js_rewards.to_py()
            decisions = js_decisions.to_py()

            # Data
            # arms = ['Arm1', 'Arm2']
            #decisions = ['Arm1', 'Arm1', 'Arm2', 'Arm1']
            #rewards = [20, 17, 25, 9]

            # Model
            mab = MAB(arms, LearningPolicy.UCB1(alpha=1.25))

            # Train
            mab.fit(decisions, rewards)

            # Test
            mab.predict()
        `);
        let toc = new Date();
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
