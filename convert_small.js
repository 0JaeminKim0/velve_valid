const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const uploadDir = '/home/user/uploaded_files';
const dataDir = './data';

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const files = fs.readdirSync(uploadDir);

function convertExcel(filePath, outputName) {
  console.log(`Converting: ${path.basename(filePath)}`);
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  const jsonData = XLSX.utils.sheet_to_json(worksheet);
  
  const outputPath = path.join(dataDir, `${outputName}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(jsonData, null, 2));
  console.log(`  -> ${outputPath} (${jsonData.length} rows)`);
  if (jsonData.length > 0) {
    console.log(`  Columns: ${Object.keys(jsonData[0]).join(', ')}`);
  }
  return jsonData;
}

// Only convert small files (skip the 9MB performance file)
files.forEach(f => {
  const filePath = path.join(uploadDir, f);
  const stat = fs.statSync(filePath);
  
  if (f.endsWith('.xlsx') && stat.size < 200000) {
    if (stat.size > 100000) {
      convertExcel(filePath, 'price_table');
    } else if (stat.size > 30000 && stat.size < 50000 && !f.includes('LME')) {
      convertExcel(filePath, 'vendor_quotes');
    } else if (f.includes('LME')) {
      convertExcel(filePath, 'lme');
    }
  }
});

console.log('\n✅ Small files converted!');
