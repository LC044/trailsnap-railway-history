import { publishExisting } from './history/retained';
try { publishExisting(); } catch(error) {console.error(error);process.exitCode=1;}
