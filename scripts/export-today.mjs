import { exportToday } from './exporter.mjs';

const limit=Number(process.argv[2]??Infinity);
if(!(limit>=0))throw new Error('El límite debe ser un número no negativo.');
try{
  const result=await exportToday({limit,onProgress:event=>console.log(JSON.stringify(event))});
  console.log(JSON.stringify(result));
}catch(error){console.error(error.message);process.exitCode=1;}
