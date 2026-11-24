const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..'),lock=JSON.parse(fs.readFileSync(path.join(root,'package-lock.json'),'utf8')),app=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
const inventory=[],notices=[];
// 记录实际安装文件与锁文件中的平台可选项，缺失不可冒充已检查许可证。
for(const [relative,entry] of Object.entries(lock.packages||{})){
 if(!relative||!relative.startsWith('node_modules/'))continue;
 const directory=path.join(root,relative),pkgFile=path.join(directory,'package.json');
 const installed=fs.existsSync(pkgFile)?JSON.parse(fs.readFileSync(pkgFile,'utf8')):null;
 const name=installed?.name||entry.name||relative.slice(relative.lastIndexOf('node_modules/')+13),license=installed?.license||entry.license||'UNKNOWN';
 if(installed&&installed.version!==entry.version)throw Error(`依赖版本与锁文件不同：${name}`);
 const files=installed?fs.readdirSync(directory).filter(file=>/^(licen[cs]e|copying|notice)([._-].*)?$/i.test(file)&&fs.statSync(path.join(directory,file)).isFile()):[];
 const row={name,version:entry.version,license,distributionReview:/LGPL|GPL|MPL|CC-BY/.test(String(license)),scope:app.dependencies?.[name]?'direct-runtime':app.devDependencies?.[name]?'direct-development':'transitive',optional:!!entry.optional,installed:!!installed,licenseFiles:files.map(file=>`${relative}/${file}`),status:files.length?'collected':installed?'metadata-only':'not-installed'};
 inventory.push(row);
 for(const file of files)notices.push(`===== ${name} ${entry.version} · ${file} =====\n${fs.readFileSync(path.join(directory,file),'utf8')}\n`);
}
for(const file of fs.readdirSync(path.join(root,'public/fonts')).filter(file=>/license/i.test(file)))notices.push(`===== public/fonts/${file} =====\n${fs.readFileSync(path.join(root,'public/fonts',file),'utf8')}\n`);
const report={format:'form-studio-dependency-inventory',lockfileVersion:lock.lockfileVersion,applicationVersion:app.version,platform:process.platform,arch:process.arch,packages:inventory.sort((a,b)=>a.name.localeCompare(b.name)),notes:['来源是本地锁文件、实际package.json及发行包LICENSE/NOTICE，不是法律结论。','collected只代表找到并保留许可文件，不代表捆绑依赖和分发义务全部核实。','依赖树含LGPL/MPL/CC-BY项目，不能统称MIT；distributionReview标出需按分发形式复核的条目。','未安装的平台可选包只记录锁文件元数据，部署构建时保留对应发行包许可。','摄影来源与使用范围另见THIRD_PARTY_NOTICES.md，软件许可不能推导照片再分发权。']};
fs.writeFileSync(path.join(root,'docs/DEPENDENCY_INVENTORY.json'),JSON.stringify(report,null,2));
fs.writeFileSync(path.join(root,'THIRD_PARTY_LICENSES.txt'),notices.join('\n'));
console.log(JSON.stringify({packages:inventory.length,collected:inventory.filter(p=>p.status==='collected').length,metadataOnly:inventory.filter(p=>p.status==='metadata-only').map(p=>p.name),notInstalled:inventory.filter(p=>!p.installed).length,unknownLicenses:inventory.filter(p=>p.license==='UNKNOWN').map(p=>p.name)}));
