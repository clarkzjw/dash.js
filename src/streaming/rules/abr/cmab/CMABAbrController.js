import FactoryMaker from '../../../../core/FactoryMaker';

function CMABAbrController() {
    let instance;
    let selectedArm;

    function timediff(tic, toc) {
        return (toc - tic) / 1000.0;
    }

    function getCMABNextQuality(pyodide, cmabContext, cmabArms, currentQualityLevel, currentLatency, playbackRate, throughput, metrics) {
        let tic = new Date();
        console.log(`cmabContext ${cmabContext}, cmabArms ${cmabArms}`);
        console.log(`Throughput ${Math.round(throughput)} kbps, playback rate ${playbackRate}, current latency ${currentLatency}`);
        console.log('getCMABNextQuality', tic);

        selectedArm = pyodide.runPython(`
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
        let toc = new Date();
        console.log(selectedArm, 'time used' , timediff(tic, toc));

        return 0;
    }

    instance = {
        getCMABNextQuality,
    };

    return instance;
}

CMABAbrController.__dashjs_factory_name = 'CMABAbrController';
export default FactoryMaker.getClassFactory(CMABAbrController);
