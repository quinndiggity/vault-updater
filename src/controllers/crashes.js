exports.setup = (runtime) => {
  let braveCorePost = {
    method: 'POST',
    path: '/1/bc-crashes',
    config: {
      description: "Proxy crash reports to Fastly endpoint",
      handler: {
        proxy: {
          uri: process.env.CRASH_PROXY,
          passThrough: true,
          timeout: 30000
        }
      }
    }
  }

  return [braveCorePost]
}
