var log = require('logger')('services:index');
var _ = require('lodash');
var async = require('async');
var express = require('express');
var bodyParser = require('body-parser');

var errors = require('errors');
var mongutils = require('mongutils');
var models = require('models');
var auth = require('auth');
var throttle = require('throttle');
var serandi = require('serandi');
var model = require('model');

var bootstrap = function (req, res, next) {
  var name = req.params.model;
  var o = models[name];
  if (!o) {
    return next(errors.notFound());
  }

  var service = o.service;

  req.ctx.model = o.model;
  req.ctx.service = o.service;

  serandi.serve(req, res, next,
    serandi.locate('/v/' + name + '/'),
    auth(service.auth),
    throttle.apis(name),
    bodyParser.json(),
    function (req, res, next) {
      next();
    });
};

var base = {
  auth: {
    GET: [
      '^\/$',
      '^\/.*'
    ]
  },
  xactions: {},
  workflow: 'model',
  createOne: function (req, res, next) {
    serandi.serve(req, res, next,
      serandi.json,
      function (req, res, next) {
        serandi.serve(req, res, next, serandi.create(req.ctx.model));
      },
      function (req, res, next) {
        model.create(req.ctx, function (err, o) {
          if (err) {
            if (err.code === mongutils.errors.DuplicateKey) {
              return next(errors.conflict());
            }
            return next(err);
          }
          res.locate(o.id).status(201).send(o);
        });
      });
  },
  find: function (req, res, next) {
    serandi.serve(req, res, next,
      function (req, res, next) {
        serandi.serve(req, res, next, serandi.find(req.ctx.model));
      },
      function (req, res, next) {
        model.find(req.ctx, function (err, oo, paging) {
          if (err) {
            return next(err);
          }
          res.many(oo, paging);
        });
      });
  },
  findOne: function (req, res, next) {
    serandi.serve(req, res, next,
      function (req, res, next) {
        serandi.serve(req, res, next, serandi.findOne(req.ctx.model));
      },
      function (req, res, next) {
        model.findOne(req.ctx, function (err, o) {
          if (err) {
            return next(err);
          }
          res.send(o);
        });
      });
  },
  updateOne: function (req, res, next) {
    serandi.serve(req, res, next,
      serandi.json,
      function (req, res, next) {
        var service = req.ctx.service;
        serandi.serve(req, res, next, serandi.transit({
          workflow: service.workflow,
          model: req.ctx.model
        }));
      });
  },
  replaceOne: function (req, res, next) {
    serandi.serve(req, res, next,
      serandi.json,
      function (req, res, next) {
        serandi.serve(req, res, next, serandi.update(req.ctx.model));
      },
      function (req, res, next) {
        model.update(req.ctx, function (err, o) {
          if (err) {
            return next(err);
          }
          res.locate(o.id).status(200).send(o);
        });
      });
  },
  removeOne: function (req, res, next) {
    serandi.serve(req, res, next,
      function (req, res, next) {
        serandi.serve(req, res, next, serandi.remove(req.ctx.model));
      },
      function (req, res, next) {
        model.remove(req.ctx, function (err) {
          if (err) {
            return next(err);
          }
          res.status(204).end();
        });
      });
  }
};

var must = function (serve) {
  return function (req, res, next) {
    if (!serve) {
      return next(errors.notFound());
    }
    serve(req, res, next);
  };
};

var bumpers = function (service) {
  if (service.bumpup) {
    return;
  }
  var post = service.xactions.post;
  if (!post) {
    post = {};
    service.xactions.post = post;
  }
  post.bumpup = serandi.bumpup;
};

var findService = function (service) {
  var serv = _.merge({}, service);

  serv.auth = serv.auth || base.auth;
  serv.xactions = serv.xactions || base.xactions;
  serv.workflow = serv.workflow || base.workflow;

  bumpers(serv);

  Object.keys(serv).forEach(function (key) {
    if (['auth', 'xactions', 'workflow', 'bumpup'].indexOf(key) !== -1) {
      return;
    }
    var val = serv[key];
    if (!val || val instanceof Function) {
      return;
    }
    serv[key] = base[key];
  });

  return serv;
};

var bootServices = function (done) {
  async.each(Object.keys(models), function (name, modelDone) {
    var o = models[name];
    o.service(function (err, service) {
      if (err) {
        return modelDone(err);
      }
      o.service = findService(service);
      modelDone();
    });
  }, done);
};

var v = function (app) {
  app.use(serandi.ctx);

  app.post('/:model',
    bootstrap,
    function (req, res, next) {
      var service = req.ctx.service;
      serandi.serve(req, res, next, must(service.createOne));
    });

  app.post('/:model/:id',
    bootstrap,
    serandi.id,
    function (req, res, next) {
      var service = req.ctx.service;
      var xactions = service.xactions;
      var actions = xactions.post;
      if (!actions) {
        return next();
      }
      serandi.serve(req, res, next, must(serandi.xactions(actions)));
    },
    function (req, res, next) {
      var service = req.ctx.service;
      serandi.serve(req, res, next, must(service.updateOne));
    });

  app.get('/:model/:id',
    bootstrap,
    serandi.id,
    function (req, res, next) {
      var service = req.ctx.service;
      serandi.serve(req, res, next, must(service.findOne));
    });

  app.put('/:model/:id',
    bootstrap,
    serandi.id,
    function (req, res, next) {
      var service = req.ctx.service;
      serandi.serve(req, res, next, must(service.replaceOne));
    });

  app.get('/:model',
    serandi.many,
    bootstrap,
    function (req, res, next) {
      var service = req.ctx.service;
      serandi.serve(req, res, next, must(service.find));
    });

  app.delete('/:model/:id',
    bootstrap,
    serandi.id,
    function (req, res, next) {
      var service = req.ctx.service;
      serandi.serve(req, res, next, must(service.removeOne));
    });

  return app;
};

module.exports = function (app, done) {
  bootServices(function (err) {
    if (err) {
      return done(err);
    }
    app.use('/v', v(express()));
    done();
  });
};
