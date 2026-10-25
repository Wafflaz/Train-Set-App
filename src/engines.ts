// Whistle assignments. BBC has no recording of these exact engines; mapped by railway/era.
export interface WhistleParams {
  attack: number;      // seconds to fade in
  tail: number;        // max seconds of natural tail played after release
  release: number;     // seconds of final fade-out at the end of the tail
  loopStart: number;   // 0..1 of the audible part of the sample
  loopEnd: number;     // 0..1 of the audible part of the sample
  crossfade: number;   // seconds: loop seam blend
  pitch: number;       // playbackRate, 1 = original
  volume: number;      // 0..1
  auto: boolean;       // loop points chosen by analysis
  oneShot: boolean;    // true: key press plays the whole whistle once, release is ignored
}

/** What the engine sounds like on the move: its own chuffs, its own steam release, and a little tone shaping. */
export interface EngineVoice {
  chuff: { url: string; from: number; to: number };
  steam: { url: string; from: number; len: number };
  pitch: number;       // playback-rate scale for chuffs and steam (smaller engine = higher)
  beat: number;        // multiplies the chuffs-per-second the speed asks for
  low: number;         // low-shelf dB (body)
  high: number;        // high-shelf dB (bark)
  level: number;       // trim so the engines sit at similar loudness
  steamTrim: number;   // the peaky steam recordings were peak-limited: bring their loudness back to match
  desc: string;
}

export interface Engine {
  id: string;
  name: string;
  plate: string;       // cab-side plate text
  sample: string;      // BBC sound id
  note: string;        // why this sample
  key: string;         // default keyboard key (KeyboardEvent.key)
  params: WhistleParams;
  voice: EngineVoice;
}

const base: WhistleParams = {
  attack: 0.08, tail: 1.2, release: 0.3, loopStart: 0.3, loopEnd: 0.6, crossfade: 0.1,
  pitch: 1, volume: 0.9, auto: true, oneShot: false,
};

export const ENGINES: Engine[] = [
  {
    id: 'holden', name: 'Holden', plate: 'G W R   No. 101', sample: '07045045', note: 'BBC: GWR steam whistle', key: '1', params: { ...base },
    voice: {
      chuff: { url: '/audio/engine/07024074.mp3', from: 30, to: 44 },
      steam: { url: '/audio/engine/07045052.mp3', from: 52.4, len: 14 },
      pitch: 1.0, beat: 1.0, low: 1, high: 0, level: 1.0, steamTrim: 1.5, desc: 'BBC 2-6-2 tank: steady GWR-style beat, long sigh of steam',
    },
  },
  {
    id: 'pug', name: 'Caledonian Pug', plate: 'No. 56025   Smokey Joe', sample: '07045048', note: 'BBC: LMS steam whistle (Caledonian became LMS)', key: '2', params: { ...base, pitch: 1.12 },
    voice: {
      chuff: { url: '/audio/engine/07006065.mp3', from: 9.0, to: 20.5 },
      steam: { url: '/audio/engine/07038282.mp3', from: 9.85, len: 15.5 },
      pitch: 1.12, beat: 1.18, low: -2, high: 3, level: 0.95, steamTrim: 1.0, desc: 'BBC Stroudley tank: quick, sharp little barks',
    },
  },
  {
    id: 'nellie', name: 'Nellie', plate: '0-4-0 T   No. 7', sample: '07006067', note: 'BBC: Stroudley 0-6-0T whistle', key: '3', params: { ...base, pitch: 1.2 },
    voice: {
      chuff: { url: '/audio/engine/07038212.mp3', from: 36, to: 52 },
      steam: { url: '/audio/engine/07038215.mp3', from: 34.6, len: 4.4 },
      pitch: 1.22, beat: 1.05, low: -4, high: 4, level: 1.1, steamTrim: 1.0, desc: 'BBC narrow-gauge engine: light, high, short sharp blow-off',
    },
  },
  {
    id: 'benton', name: 'Benton', plate: '0-4-0 T   No. 4', sample: '07045049', note: 'BBC: LMS whistle, pitched down', key: '4', params: { ...base, pitch: 0.85 },
    voice: {
      chuff: { url: '/audio/engine/07024105.mp3', from: 200, to: 262 },
      steam: { url: '/audio/engine/07045062.mp3', from: 23.5, len: 14 },
      pitch: 0.88, beat: 0.82, low: 4, high: -2, level: 0.95, steamTrim: 1.9, desc: 'BBC Maunsell Q 0-6-0 pulling hard: heavy, slow, deep',
    },
  },
];

export interface EnvLayer {
  id: string;
  url: string;
  from: number;
  to: number;
  group: 'birds' | 'wind' | 'people';
  gain: number;      // base level inside its group
  xf: number;        // loop crossfade, seconds
}

// Engine-sound sources (BBC ids in the file names). Times in seconds.
export const SAMPLES = {
  whistleDir: '/audio/whistles',
  // Loco standing in station: steady stretch looped as the stationary ambience
  idle: { url: '/audio/ambience/07024097.mp3', from: 15, to: 45 },
  // Steam crane on squealing rails: the steady squeal stretch, high-passed in the graph
  squeal: { url: '/audio/track/07045039.mp3', from: 13.5, to: 19.8 },
  // Wagon wheels over rail joints, from steam goods trains passing: cut into single clacks
  clacks: [
    { url: '/audio/track/07006086.mp3', from: 38, to: 62 },
    { url: '/audio/track/07006084.mp3', from: 54, to: 66 },
    { url: '/audio/track/07006091.mp3', from: 8, to: 22 },
  ],
  // Loose stones falling: single clacks cut out and scattered while the train runs
  rocks: [
    { url: '/audio/track/07037414.mp3', from: 0, to: 24 },
    { url: '/audio/track/07037415.mp3', from: 0, to: 8 },
  ],
  env: [
    { id: 'garden', url: '/audio/env/NHU05085339.mp3', from: 4, to: 58, group: 'birds', gain: 0.75, xf: 3 },
    { id: 'dawn', url: '/audio/env/NHU05104035.mp3', from: 3, to: 40, group: 'birds', gain: 0.55, xf: 3 },
    { id: 'summer', url: '/audio/env/0009032.mp3', from: 0.2, to: 29.5, group: 'birds', gain: 0.5, xf: 2.5 },
    { id: 'breeze', url: '/audio/env/00008017.mp3', from: 0.2, to: 28.5, group: 'wind', gain: 0.9, xf: 2.5 },
    { id: 'trees', url: '/audio/env/NHU05058215.mp3', from: 3.6, to: 12.2, group: 'wind', gain: 1.0, xf: 2 },
    { id: 'children', url: '/audio/env/07039116.mp3', from: 3, to: 68, group: 'people', gain: 0.55, xf: 3 },
    { id: 'murmur', url: '/audio/env/0009021.mp3', from: 0.2, to: 29.5, group: 'people', gain: 0.8, xf: 2.5 },
  ] as EnvLayer[],
};
