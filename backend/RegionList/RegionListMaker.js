const xlsx = require("xlsx");
const fs = require("fs");

// Load the Excel file
const workbook = xlsx.readFile("ARA2_annotation_structure_info_v2.xlsx");

// Get the first sheet
const sheetName = workbook.SheetNames[0];
const sheet = workbook.Sheets[sheetName];

// Convert sheet to JSON
const data = xlsx.utils.sheet_to_json(sheet);

// Map to only id and name
const regionList = data.map(row => ({
    id: row.id,
    name: row.name
}));

// Create JS array string
const jsArray = `const REGION_LIST = ${JSON.stringify(regionList, null, 2)};`;

// Save to a JS file
fs.writeFileSync("regionList.js", jsArray);

console.log("regionList.js created with only id and name!");