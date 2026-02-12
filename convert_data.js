const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const uploadDir = '/home/user/uploaded_files';
const dataDir = './data';

// Ensure data directory exists
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Find files by pattern
const files = fs.readdirSync(uploadDir);
console.log('Files in upload directory:');
files.forEach((f, i) => {
  const stat = fs.statSync(path.join(uploadDir, f));
  console.log(`  ${i}: ${f} (${stat.size} bytes)`);
});

// Convert Excel to JSON
function convertExcel(filePath, outputName) {
  if (!fs.existsSync(filePath)) {
    console.log(`File not found: ${filePath}`);
    return null;
  }
  
  console.log(`\nConverting: ${path.basename(filePath)}`);
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  const jsonData = XLSX.utils.sheet_to_json(worksheet);
  
  const outputPath = path.join(dataDir, `${outputName}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(jsonData, null, 2));
  console.log(`  -> ${outputPath} (${jsonData.length} rows)`);
  
  // Show first row structure
  if (jsonData.length > 0) {
    console.log(`  Columns: ${Object.keys(jsonData[0]).slice(0, 10).join(', ')}...`);
  }
  
  return jsonData;
}

// Find and convert files by size pattern
files.forEach(f => {
  const filePath = path.join(uploadDir, f);
  const stat = fs.statSync(filePath);
  
  if (f.endsWith('.xlsx')) {
    if (stat.size > 9000000) {
      // Large file = performance (~9.6MB)
      convertExcel(filePath, 'performance');
    } else if (stat.size > 100000 && stat.size < 150000) {
      // Medium file = price_table (~104KB)
      convertExcel(filePath, 'price_table');
    } else if (stat.size > 30000 && stat.size < 50000 && !f.includes('LME')) {
      // Small file = vendor_quotes (~40KB)
      convertExcel(filePath, 'vendor_quotes');
    } else if (f.includes('LME')) {
      convertExcel(filePath, 'lme');
    }
  }
});

console.log('\n✅ Data conversion complete!');
