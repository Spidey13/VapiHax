import { Config } from '@remotion/cli/config';

// The film's pictures are the app's own page: keep colours exact and the text crisp.
Config.setVideoImageFormat('png');
Config.setPixelFormat('yuv420p');
Config.setCodec('h264');
Config.setCrf(16);
