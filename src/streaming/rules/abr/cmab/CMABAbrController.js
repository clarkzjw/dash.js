import FactoryMaker from '../../../../core/FactoryMaker';

function CMABAbrController() {
    let instance;

    function getNextQuality() {
        return 0;
    }


    instance = {
        getNextQuality,
    };

    return instance;
}

CMABAbrController.__dashjs_factory_name = 'CMABAbrController';
export default FactoryMaker.getClassFactory(CMABAbrController);
