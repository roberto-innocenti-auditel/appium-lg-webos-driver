import {Client} from 'ssh2';
import { promises as fs } from 'fs';
import B from 'bluebird';
import log from '../logger';

/**
 * @implements {LGSshClient}
 */
export class LGSshClient {
  /**
   *
   * @param {import('../types').LGSshClientOpts} opts
   */
  constructor({host, port, username, privateKey}) {
    this.host = host;
    this.port = port;
    this.username = username;
    this.privateKey = privateKey;
    this.conn = new Client();
  }

  async connect() {
    return new B((resolve, reject) => {
      this.conn
        .on('ready', () => {
          log.info(`SSH connection to ${this.host} is ready`);
          resolve();
        })
        .on('error', (err) => {
          log.error(`SSH connection error: ${err.message}`);
          reject(err);
        })
        .connect({
          host: this.host,
          port: this.port,
          username: this.username,
          privateKey: this.privateKey,
        });
    });
  }

  disconnect() {
    log.info(`Disconnecting SSH from ${this.host}`);
    this.conn.end();
  }

  /**
   * @param {string} service
   * @param {string} method
   * @param {object} parameters
   * @returns {Promise<any>}
   */
  async lunaSend(service, method, parameters = {}) {
    const cmd = `luna-send -n 1 ${service}/${method} '${JSON.stringify(parameters)}'`;
    log.info(`Executing SSH command: ${cmd}`);
    return new B((resolve, reject) => {
      this.conn.exec(cmd, (err, stream) => {
        if (err) {
          return reject(err);
        }
        let buffer = '';
        stream
          .on('close', (code) => {
            log.debug(`SSH command executed with code ${code}`);
            try {
              const result = JSON.parse(buffer);
              if (result.returnValue === false) {
                return reject(new Error(`Luna command failed: ${buffer}`));
              }
              resolve(result);
            } catch (e) {
              reject(
                new Error(`Could not parse Luna command output: ${buffer}. Original error: ${e.message}`),
              );
            }
          })
          .on('data', (data) => {
            buffer += data.toString();
          })
          .stderr.on('data', (data) => {
            log.error(`SSH command stderr: ${data}`);
            reject(new Error(data.toString()));
          });
      });
    });
  }

  /**
   * Downloads a file from the remote device to the local path using SCP
   * @param {string} remotePath
   * @param {string} localPath
   * @returns {Promise<void>}
   */
  async scpGet(remotePath, localPath) {
    log.debug(`Starting SCP download from ${remotePath} to ${localPath}`);
    return new B((resolve, reject) => {
      this.conn.sftp((err, sftp) => {
        if (err) {
          return reject(err);
        }
        sftp.fastGet(remotePath, localPath, (getErr) => {
          if (getErr) {
            return reject(getErr);
          }
          log.debug(`SCP download completed from ${remotePath} to ${localPath}`);
          resolve();
        });
      });
    });
  }

  /**
   * Deletes a file on the remote device using SCP
   * @param {string} remotePath
   * @returns {Promise<void>}
   */  
  async scpDel(remotePath) {
    log.info(`Starting SCP delete of ${remotePath}`);
    return new B((resolve, reject) => {
      this.conn.sftp((err, sftp) => {
        if (err) {
          return reject(err);
        }
        sftp.unlink(remotePath, (delErr) => {
          if (delErr) {
            return reject(delErr);
          }
          log.debug(`SCP delete completed for ${remotePath}`);
          resolve();
        });
      });
    });
  }

  /**
   *
   * Implements screen capture using luna-send command
   * luna-send -n 1 -f luna://com.webos.surfacemanager/captureCompositorOutput '{"output":"/home/root/screenshot-temp.jpg","format":"JPG"}'
   * @param {import('../types').CaptureOptions} opts
   * @returns
   */
  async captureScreen(opts) {
    const {sessionId, format = 'PNG', width, height} = opts;
    const payload = {
      output: `/tmp/appium_screenshot_${sessionId}_${Date.now()}.${format.toLowerCase()}`,
      format,
    };
    await this.lunaSend('luna://com.webos.surfacemanager', 'captureCompositorOutput', payload);
    // Download the screenshot to local machine, convert to base64, and delete both local and remote files
    await this.scpGet(payload.output, payload.output);
    log.debug(`Screenshot saved to ${payload.output} on this device.`);
    const imageBuffer = await fs.readFile(payload.output);
    const base64Image = imageBuffer.toString('base64');
    log.debug('Screenshot converted to base64 string. Deleting temporary files.');
    setTimeout(async () => {
      try {
        await fs.unlink(payload.output);
        await this.scpDel(payload.output);
        log.debug(`Temporary screenshot file ${payload.output} deleted from both devices.`);
      } catch (error) {
        log.error(`Error deleting temporary screenshot files: ${error.message}`);
      }
    }, 1000);
    return base64Image;
  }


  /**
   * Uploads a file from a given URL to the device
   * Upload status codes.
   *   0 - OK
   *   1 - General error
   *   2 - Invalid parameter
   * @param {string} filePath The path of the file on the device
   * @param {string} url The URL of the file to be uploaded (must be accessible by the device)
   * @returns {Promise<import('../types').LunaResponse>}
   */
  async uploadFile(filePath, url) {
    // luna-send -n 1 -f luna://com.webos.service.downloadmanager/upload '{"target":"<url>","targetDir":"/tmp","targetFilename":"appium_screenshot_1234567890.png"}'
    const payload = {target: url, targetDir: '/tmp', targetFilename: filePath};
    return this.lunaSend('luna://com.webos.service.downloadmanager', 'upload', payload);
  }

  /**
   *
   * Implements screen capture using luna-send command
   * luna-send -n 1 -f luna://com.webos.surfacemanager/captureCompositorOutput '{"output":"/home/root/screenshot-temp.jpg","format":"JPG"}'
   * @param {import('../types').CaptureOptions} opts
   * @returns
   */
  async getWindowRect(opts) {
    const {sessionId, format = 'PNG', width, height} = opts;
    const payload = {
      output: `/tmp/appium_screenshot_${sessionId}_${Date.now()}.${format.toLowerCase()}`,
      format,
    };

    const result = await this.lunaSend('luna://com.webos.surfacemanager', 'captureCompositorOutput', payload);
    const heightWidth = result.resolution.split('x');
    return {
      width: parseInt(heightWidth[0], 10),
      height: parseInt(heightWidth[1], 10),
      x: 0,
      y: 0,
    };
  }
}
