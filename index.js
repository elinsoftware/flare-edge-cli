#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const { Sema } = require('async-sema');
const kleur = require('kleur');
const archiver = require('archiver');
const os = require('os');


const configFile = './flare-edge.config.json';
// Check if file exists
if (!fs.existsSync(configFile)) {
  console.error('Configuration file does not exist.');
  process.exit(1);
}
// Load configuration file
let config = {}
try {
  config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
} catch (err) {
  console.error(`Error reading configuration file: ${err}`);
  process.exit(1);
}

const {
  apiKey,
  secretKey,
  gatewayKey,
  domainSpace,
  containerName,
  folderPath,
  gateway,
  servicenow
} = config;

const maxUploadsPerSecond = 8;
const uploadLimiter = new Sema(maxUploadsPerSecond, { capacity: maxUploadsPerSecond });

async function deleteContainerContents() {
    try {
      const response = await axios.post(`https://${gateway}/deleteContainerContents`, {
        apiKey,
        secretKey,
        domainSpace,
        containerName,
        gatewayKey,
      });
  
      console.log('Container contents deleted successfully.');
      return response.data;
    } catch (error) {
      console.error('Error deleting container contents:', error.message);
      process.exit(1);
      return null;
    }
  }
  async function purgeCDN() {
    try {
      const response = await axios.post(`https://${gateway}/purgeContainer`, {
        apiKey,
        secretKey,
        domainSpace,
        containerName,
        gatewayKey,
      });
  
      console.log('Container updated successfully.');
      return response.data;
    } catch (error) {
      console.error('Error updating container contents:', error.message);
      process.exit(1);
      return null;
    }
  }

async function uploadFile(filePath) {
  try {
    const fileStream = fs.createReadStream(filePath);
    const formData = new FormData();
    formData.append('file', fileStream, path.basename(filePath));
    formData.append('apiKey', apiKey);
    formData.append('secretKey', secretKey);
    formData.append('domainSpace', domainSpace);
    formData.append('containerName', containerName);
    formData.append('filePath', path.relative(folderPath, filePath));
    formData.append('gatewayKey', gatewayKey);
    const response = await axios.post(`https://${gateway}/uploadFile`, formData, {
      headers: formData.getHeaders(),
    });

    console.log(
        'File: ',
        kleur.yellow(`${filePath}`),
        response.data.success ? kleur.blue('done') : response.data
      );
  } catch (error) {
    console.log(kleur.red(`Error uploading file: ${error.message}`));
    process.exit(1);
  }
}

function walkDir(dir, callback) {
    let promises = [];
    fs.readdirSync(dir).forEach(file => {
      const filePath = path.join(dir, file);
      if (fs.statSync(filePath).isDirectory()) {
        promises.push(...walkDir(filePath, callback));
      } else {
        promises.push(callback(filePath));
      }
    });
  
    return promises;
  }
  
  const zipFiles = async (folderName, outputFile) => {
    return new Promise((resolve, reject) => {
      try {
          const output = fs.createWriteStream(outputFile);
          const archive = archiver('zip', {
              zlib: { level: 9 } // Sets the compression level.
          });
          
          output.on('close', function() {
              resolve();
          });
          
          archive.on('error', function(err) {
              console.log(kleur.red(`Failed to create zip file: ${err.message}`));
              reject(err);
          });

          archive.pipe(output);
          
          archive.glob('**/*', {
              cwd: folderName,
              ignore: ['node_modules/**/*']
          });

          archive.finalize();
      } catch (error) {
          console.log(kleur.red(`Failed to create zip file: ${error.message}`));
          reject(error);
      }
  });
};

const sendToServiceNow = async (filePath, fileName, sys_id, instance, username, password) => {
  const url = `${instance}/api/now/attachment/file?table_name=x_elsr_fedge_project&table_sys_id=${sys_id}&file_name=${fileName}`;
  const data = fs.readFileSync(filePath);
  const options = {
      headers: {
          'Accept':'application/json',
          'Content-Type':'application/octet-stream',
          'Authorization': 'Basic ' + Buffer.from(username + ':' + password).toString('base64')
      }
  };
  try {
    const response = await axios.post(url, data, options);
    return response;
} catch (error) {
    console.log(kleur.red(`Error: ${error.message}`));
    process.exit(1);
}
};

const deployCodeToServiceNow = async () => {
  const folderName = '.'; // Current folder
  const outputFile = path.join(os.tmpdir(), 'source_code.zip'); // Output zip file in temporary directory
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `source_code_${timestamp}.zip`; // Name for the file in ServiceNow

  await zipFiles(folderName, outputFile);
  await sendToServiceNow(outputFile, fileName, servicenow.project_sys_id, servicenow.instance, servicenow.username, servicenow.password);
  // Delete the output file after it's sent
    fs.unlinkSync(outputFile);
};

async function main() {
  console.log('FlareEdge v1.2.0');
  console.log('Cleaning up...')
  await deleteContainerContents();
  console.log('Deploying to FlareEdge...')

  const uploadPromises = walkDir(folderPath, async filePath => {
    await uploadLimiter.acquire();
    const uploadPromise = uploadFile(filePath).finally(() => {
      setTimeout(() => {
        uploadLimiter.release();
      }, 1000);
    });

    return uploadPromise;
  });

  await Promise.all(uploadPromises);
  await purgeCDN()
  if (servicenow)  {
    await deployCodeToServiceNow();
    console.log('Project source code copied to ServiceNow.');
  }
  console.log('Done. Project has been deployed to FlareEdge.');
}

  main();