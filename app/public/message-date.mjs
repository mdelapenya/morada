const dayPattern=/^\d{4}-\d{2}-\d{2}$/;
const validDay=value=>typeof value==='string' && dayPattern.test(value) &&
  Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)===value;
const madridDay=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Madrid',
  year:'numeric',month:'2-digit',day:'2-digit'});
const displayDay=new Intl.DateTimeFormat('es-ES',{timeZone:'UTC',
  day:'numeric',month:'long',year:'numeric'});

function dayAt(value){
  if(typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) ||
    !validDay(value.slice(0,10)) || !Number.isFinite(Date.parse(value)))return null;
  if(new Date(value).toISOString()!==(value.includes('.')?value:value.replace('Z','.000Z')))return null;
  return madridDay.format(new Date(value));
}

/** Relative DOM labels belong to the saved snapshot, never to the viewing day. */
export function formatMessageDate(message, snapshot={}){
  let day=validDay(message.messageDate)?message.messageDate:dayAt(message.occurredAt);
  const label=typeof message.dateLabel==='string'?message.dateLabel.trim():'';
  const relative=/^(hoy|ayer)$/i.test(label);
  if(!day && relative){
    const reference=validDay(snapshot.referenceDay)?snapshot.referenceDay:
      dayAt(snapshot.referenceAt)??dayAt(snapshot.exportedAt);
    if(reference)day=label.toLocaleLowerCase('es-ES')==='ayer'?
      new Date(Date.parse(`${reference}T00:00:00Z`)-86400000).toISOString().slice(0,10):reference;
  }
  if(day)return displayDay.format(new Date(`${day}T00:00:00Z`));
  if(relative)return `Fecha no determinada (Idealista mostraba «${label}» al sincronizar)`;
  return label||'Fecha no indicada';
}
