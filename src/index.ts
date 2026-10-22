import { collect } from './collect';
collect().catch(error=>{console.error(error);process.exitCode=1;});
