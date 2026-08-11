import os from 'os';
import dotenv from 'dotenv';

if (os.platform() == 'linux')
    dotenv.config({ path: ".env.production" });
else
    dotenv.config({ path: ".env.development" });

dotenv.config();