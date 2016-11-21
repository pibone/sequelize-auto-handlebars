var Sequelize = require('sequelize');
var async = require('async');
const fs = require('graceful-fs-extra');
const mkdirp = require('mkdirp');
const path = require('path');
const Handlebars = require('handlebars');
var _ = require('lodash/fp');
var dialects = require('./dialects');
const Promise = require('bluebird');

const mapValuesWithKeys = _.mapValues.convert({cap: false});

const build = (config) => {
  const sequelize = new Sequelize(config.database, config.username, config.password, { host: config.host, dialect: config.dialect });
  const options = {
    sequelize: sequelize,
    values: config,
    queryInterface: sequelize.getQueryInterface(),
    dialectInterface: dialects[sequelize.options.dialect],
    options: _.extend({
      global: 'Sequelize',
      local: 'sequelize',
      spaces: false,
      indentation: 1,
      directory: './models',
      additional: {},
      freezeTableName: true
    }, config.options || {})
  };

    const getForeignKeysIO = (table) => !options.dialectInterface
      ? Promise.resolve({})
      : options.sequelize.query(options.dialectInterface.getForeignKeysQuery(table, config.database), {
          type: options.sequelize.QueryTypes.SELECT,
          raw: true,
        });

  const mapSQLitePragma = _.mapKeys(
    _.cond([
      // map sqlite's PRAGMA results
      [_.eq('from'), _.constant('source_column')],
      [_.eq('to'), _.constant('target_column')],
      [_.eq('table'), _.constant('target_table')],
      [_.T, _.identity],
    ])
  );

  const parseForeignKeys = (table) => (foreignKey) => _.merge(foreignKey, {
    source_table: table,
    source_schema: config.database,
    target_schema: config.database,
    isForeignKey: ! _.isEmpty(_.trim(foreignKey.source_column)) && ! _.isEmpty(_.trim(foreignKey.target_column)),
    isPrimaryKey: _.isFunction(options.dialectInterface.isPrimaryKey) && options.dialectInterface.isPrimaryKey(foreignKey),
    isSerialKey: _.isFunction(options.dialectInterface.isSerialKey) && options.dialectInterface.isSerialKey(foreignKey)
  });

  const mapForeignKeys = (table) =>
    getForeignKeysIO(table)
      .map(mapSQLitePragma)
      .map(parseForeignKeys(table))
      .map((ref) => [ref.source_column, ref])
      .then(_.fromPairs);

  const mapTables = (table) =>
    options.queryInterface.describeTable(table)
      .then((fields) =>
        Promise.all([Promise.resolve(fields), config.dialect === 'mssql'
          ? options.sequelize.query(`SELECT object_name(object_id), name, is_identity as isSerialKey FROM sys.identity_columns WHERE OBJECT_NAME(object_id) =  '${table}';`, {
            type: options.sequelize.QueryTypes.SELECT,
            raw: true,
          })
          : Promise.resolve([{}])])
      )
      .then(([fields, [serial]]) =>
        _.merge(serial ? { [serial.name]: { isSerialKey: true }} : {})(fields)
      )
      .then(
        _.mapValues(
          mapValuesWithKeys((fieldAttr, key) => {
            const pattern = /^\(((.|[\(\)])+)\)$/;
            if (key === 'defaultValue') {
              const removeParens = (f) => {
                const match = pattern.exec(f);
                return match ? removeParens(match[1]) : f;
              };
              return removeParens(fieldAttr);
            } else {
              return fieldAttr;
            }
          }
        )
      )
    );

  const mapFields = _.flow([_.over([mapForeignKeys, mapTables]), Promise.all, (all) => all.then(_.mergeAll)]);

  return options.queryInterface.showAllTables()
    .then((tables) => config.dialect === 'mssql' ? _.map('tableName', tables) : tables)
    .then((tables) => config.tables ? _.intersection(tables, config.tables) : tables)
    .map(_.flow([_.over([Promise.resolve, mapFields]), Promise.all]))
    .then(_.fromPairs)
    .then((tables) => ({ options, tables }));
}

const run = (config) => ({ options, tables }) => {
  const file = fs.readFileSync(config.template).toString();
  const tableNames = _.keys(tables);
  const getTableIntersection = _.intersection(tableNames);
  const isInTableIntersection = _.flow([(rd) => getTableIntersection([rd.source, rd.target]), _.size, _.eq(2)])
  const match = function(regex){ return (str) => str.match(regex)};
  const lowerCase = (str) => _.lowerCase(str).split(' ').join('')
  const tsNumberRegex = /^((small|medium|tiny|big)?int|float(4|8)?|decimal|numeric|double precision)$/;
  const tsStringRegex = /^(string|n?(var)?char|varying|text|ntext|uuid|uniqueidentifier)$/;
  const tsDateRegex = /^(date|datetime|datetime2|time|timestamp)$/;
  const tsBoolRegex = /^(bool|boolean|bit(\(1\))?)$/;
  const getNumber = (f) => {
    const val = f.match(/\(\d+\)/);
    return !_.isNull(val) ? val : '';
  }

  const dtName = 'Sequelize';

  const asTSType = _.flow(_.get('type'), lowerCase, _.cond([
    [match(tsNumberRegex), _.constant('number')],
    [match(tsStringRegex), _.constant('string')],
    [match(tsDateRegex), _.constant('Date')],
    [match(tsBoolRegex), _.constant('boolean')],
    [match(/^(json|jsonb)$/), _.constant('Object')],
    [match(/^geography$/), _.constant('{ lat: number, lon: number }')],
    [match(/^geometry$/), _.constant('Object')],
    [_.T, _.constant('void')],
  ]));

  const asSequelizeType = _.flow(_.get('type'), lowerCase, _.cond([
    [match(/^((small|medium|tiny)?int)/), (f) => `${dtName}.INTEGER${getNumber(f)}`],
    [match(/^(bigint)$/), _.constant(`${dtName}.BIGINT`)],
    [match(/^(boolean|bit(\(1\))?)$/), _.constant(`${dtName}.BOOLEAN`)],
    [match(/^(string|n?(var)?char|varying)$/), _.constant(`${dtName}.STRING`)],
    [match(/^(char)/), (f) => `${dtName}.CHAR${getNumber(f)}`],
    [match(/^(text|ntext)$/), _.constant(`${dtName}.TEXT`)],
    [match(/^(datetime2?)$/), _.constant(`${dtName}.DATE`)],
    [match(/^(date)$/), _.constant(`${dtName}.DATEONLY`)],
    [match(/^(time)$/), _.constant(`${dtName}.TIME`)],
    [match(/^(float|float4)$/), _.constant(`${dtName}.FLOAT`)],
    [match(/^(decimal|numeric)$/), _.constant(`${dtName}.DECIMAL`)],
    [match(/^(float8|double precision)$/), _.constant(`${dtName}.DOUBLE`)],
    [match(/^(uuid|uniqueidentifier)$/), _.constant(`${dtName}.UUIDV4`)],
    [match(/^(json)$/), _.constant(`${dtName}.JSON`)],
    [match(/^(jsonb)$/), _.constant(`${dtName}.JSONB`)],
    [match(/^(geometry)$/), _.constant(`${dtName}.GEOMETRY`)],
    [match(/^(geography)$/), _.constant(`${dtName}.GEOGRAPHY`)],
    [_.T, (type) => `'${type}'`],
  ]));

  Handlebars.registerHelper('asTSType', asTSType);
  Handlebars.registerHelper('asSequelizeType', asSequelizeType);
  Handlebars.registerHelper('defaultValue', (field) => {
    const defaultValue = _.cond([
      [_.startsWith('/****** Object:  Default [dbo].[EmptyString]'), _.constant('')],
      [_.startsWith('CREATE DEFAULT Zero'), _.constant('0')],
      [(i) => _.includes(i, ['getdate()']), _.constant('Sequelize.NOW')],
      [_.T, _.constant(field.defaultValue)],
    ])(_.trim(field.defaultValue));
    return !_.isUndefined(defaultValue) && !_.isNull(defaultValue)
      ? `defaultValue: ${_.cond([
        [_.isNull, _.constant('null')],
        [(i) => i.match(/^[0-9]+((\.\,)[0-9]+)?$/), _.identity],
        [match(/^Sequelize\.\w+/), _.identity],
        [_.T, _.constant(`'${defaultValue}'`)],
      ])(defaultValue)},` : '';
  });

  const isManyToMany = (fields) =>
        _.size(_.filter('isForeignKey')(fields)) === 2
        && ((_.size(fields) === 2)
            || _.size(fields) === 3 && _.size(_.filter({ isSerialKey: true, primaryKey: true })(fields)) === 1);

  Handlebars.registerHelper('str', (value) => `'${value}'`);
  Handlebars.registerHelper('camel', _.camelCase);
  Handlebars.registerHelper('manyToMany', (fields, { fn, inverse, data }) => {
    const foreignKeys = _.filter('isForeignKey')(fields);
    return isManyToMany(fields) ? _.flow([
      (foreignKeys) => ([{
        source: foreignKeys[1].target_table,
        target: foreignKeys[0].target_table,
        relation: foreignKeys[0].source_table,
        fk: foreignKeys[1].source_column,
      }, {
        source: foreignKeys[0].target_table,
        target: foreignKeys[1].target_table,
        relation: foreignKeys[0].source_table,
        fk: foreignKeys[0].source_column,
      }]),
      _.filter(isInTableIntersection),
      _.map((i) => fn(this, { data, blockParams: _.values(i) })),
      _.reduce((a, c) => a + c, ''),
    ])(foreignKeys) : inverse(this);
  });

  Handlebars.registerHelper('isManyToMany', (fields, options) => isManyToMany(fields) ? options.fn(this) : '');

  Handlebars.registerHelper('oneToMany', (fields, { fn, inverse, data }) => _.flow([
      _.map((foreignKey) => ({
        source: foreignKey.source_table,
        target: foreignKey.target_table,
        fk: foreignKey.source_column,
      })),
      _.filter(isInTableIntersection),
      _.map((i) => fn(this, { data, blockParams: _.values(i) })),
      _.reduce((a, c) => a + c, ''),
    ])(_.filter('isForeignKey')(fields))
  );

  Handlebars.registerHelper('camelRename', _.cond([
    [(val) => _.includes(val)(_.keys(config.renames)), (val) => _.camelCase(config.renames[val])],
    [_.T, _.camelCase],
  ]));

  Handlebars.registerHelper('rename', _.cond([
    [(val) => _.includes(val)(_.keys(config.renames)), (val) => config.renames[val]],
    [_.T, _.identity],
  ]));

  const template = Handlebars.compile(file);

  const rawText = template(_.merge({
        models: tables,
      }, options.values
    ));

  const beginRelations = (s) => s.trim() === '// Begin Relations';
  const endRelations = (s) => s.trim() === '// End Relations';

  const prepared = rawText
    .split('\n')
    .filter(s => s.trim() !== '')
    .map(_.flow([
      (s) => _.overSome([
        endRelations,
        _.endsWith('};'),
        _.endsWith('}')
      ])(s) ? s.concat('\n') : s,
      (s) => _.overSome([
        beginRelations,
        _.startsWith('export')
      ])(s) ? '\n'.concat(s) : s,
    ]))
    .join('\n')
    .concat('\n');

  options.sequelize.close();
  return prepared;
}

const write = (config) => (text) => {
  mkdirp.sync(config.output);
  fs.writeFile(path.join(config.output, _.camelCase(config.database) + '.ts'), text);
};

module.exports = { run, build, write };
