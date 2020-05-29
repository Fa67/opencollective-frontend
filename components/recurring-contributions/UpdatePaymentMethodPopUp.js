import React, { Fragment, useEffect, useState } from 'react';
import PropTypes from 'prop-types';
import { useMutation, useQuery } from '@apollo/react-hooks';
import { PlusCircle } from '@styled-icons/boxicons-regular/PlusCircle';
import { MoneyCheck } from '@styled-icons/fa-solid/MoneyCheck';
import themeGet from '@styled-system/theme-get';
import gql from 'graphql-tag';
import { first, get, pick, uniqBy } from 'lodash';
import { withRouter } from 'next/router';
import { defineMessages, FormattedDate, FormattedMessage, useIntl } from 'react-intl';
import styled from 'styled-components';

import { formatCurrency } from '../../lib/currency-utils';
import { getErrorFromGraphqlException } from '../../lib/errors';
import { API_V2_CONTEXT, gqlV2 } from '../../lib/graphql/helpers';
import { getPaymentMethodName, paymentMethodExpiration } from '../../lib/payment_method_label';
import { stripeTokenToPaymentMethod } from '../../lib/stripe';

import { Box, Flex } from '../Grid';
import CreditCard from '../icons/CreditCard';
import GiftCard from '../icons/GiftCard';
import LoadingPlaceholder from '../LoadingPlaceholder';
import NewCreditCardForm from '../NewCreditCardForm';
import { withStripeLoader } from '../StripeProvider';
import StyledButton from '../StyledButton';
import StyledHr from '../StyledHr';
import StyledRadioList from '../StyledRadioList';
import { P } from '../Text';

const PaymentMethodBox = styled(Flex)`
  border-top: 1px solid ${themeGet('colors.black.300')};
`;

const messages = defineMessages({
  cancel: {
    id: 'actions.cancel',
    defaultMessage: 'Cancel',
  },
  update: {
    id: 'subscription.updateAmount.update.btn',
    defaultMessage: 'Update',
  },
  updatePaymentMethod: {
    id: 'subscription.menu.editPaymentMethod',
    defaultMessage: 'Update payment method',
  },
  addPaymentMethod: {
    id: 'subscription.menu.addPaymentMethod',
    defaultMessage: 'Add new payment method',
  },
  save: {
    id: 'save',
    defaultMessage: 'Save',
  },
});

const getPaymentMethodsQuery = gql`
  query UpdatePaymentMethodPopUpQuery($collectiveSlug: String) {
    Collective(slug: $collectiveSlug) {
      id
      type
      slug
      name
      currency
      isHost
      settings
      paymentMethods(types: ["creditcard", "virtualcard", "prepaid"]) {
        id
        uuid
        name
        data
        monthlyLimitPerMember
        service
        type
        balance
        currency
        expiryDate
        collective {
          id
        }
        subscriptions: orders(hasActiveSubscription: true) {
          id
        }
      }
    }
  }
`;

const updatePaymentMethodMutation = gqlV2/* GraphQL */ `
  mutation updatePaymentMethod($order: OrderReferenceInput!, $paymentMethod: PaymentMethodReferenceInput!) {
    updateOrder(order: $order, paymentMethod: $paymentMethod) {
      id
    }
  }
`;

const addPaymentMethodMutation = gqlV2/* GraphQL */ `
  mutation addPaymentMethod($newPaymentMethod: PaymentMethodCreateInput!) {
    addStripeCreditCard(newPaymentMethod: $newPaymentMethod) {
      id
    }
  }
`;

const UpdatePaymentMethodPopUp = ({
  setMenuState,
  contribution,
  createNotification,
  setShowPopup,
  router,
  loadStripe,
}) => {
  const intl = useIntl();

  // state management
  const [showAddPaymentMethod, setShowAddPaymentMethod] = useState(false);
  const [selectedPaymentMethod, setSelectedPaymentMethod] = useState(null);
  const [defaultPaymentMethod, setDefaultPaymentMethod] = useState(null);
  const [loadingDefaultPaymentMethod, setLoadingDefaultPaymentMethod] = useState(true);
  const [stripeIsReady, setStripeIsReady] = useState(false);
  const [stripe, setStripe] = useState(null);
  const [newPaymentMethodInfo, setNewPaymentMethodInfo] = useState(null);

  // GraphQL mutations and queries
  const { data } = useQuery(getPaymentMethodsQuery, {
    variables: {
      collectiveSlug: router.query.collectiveSlug,
    },
  });
  const [submitUpdatePaymentMethod, { loading: loadingUpdatePaymentMethod }] = useMutation(
    updatePaymentMethodMutation,
    {
      context: API_V2_CONTEXT,
    },
  );
  const [submitAddPaymentMethod, { loading: loadingAddPaymentMethod }] = useMutation(addPaymentMethodMutation, {
    context: API_V2_CONTEXT,
  });

  // load stripe on mount
  useEffect(() => {
    loadStripe();
    setStripeIsReady(true);
  }, [stripeIsReady]);

  // data handling
  const minBalance = 50; // Minimum usable balance for virtual card

  const getPaymentMethodIcon = pm => {
    if (pm.type === 'creditcard') {
      return <CreditCard />;
    } else if (pm.type === 'virtualcard') {
      return <GiftCard />;
    } else if (pm.type === 'prepaid') {
      return <MoneyCheck width="26px" height="18px" />;
    }
  };

  const getPaymentMethodMetadata = pm => {
    if (pm.type === 'creditcard') {
      const expiryDate = paymentMethodExpiration(pm);
      return (
        <FormattedMessage
          id="ContributePayment.expiresOn"
          defaultMessage="Expires on {expiryDate}"
          values={{ expiryDate }}
        />
      );
    } else if (pm.type === 'virtualcard') {
      if (pm.balance < minBalance) {
        return (
          <FormattedMessage
            id="ContributePayment.unusableBalance"
            defaultMessage="{balance} left, balance less than {minBalance} cannot be used."
            values={{
              balance: formatCurrency(pm.balance, pm.currency),
              minBalance: formatCurrency(minBalance, pm.currency),
            }}
          />
        );
      } else if (pm.expiryDate) {
        return (
          <FormattedMessage
            id="RecurringContributions.balanceAndExpiry"
            defaultMessage="{balance} left, expires {expiryDate}"
            values={{
              expiryDate: <FormattedDate value={pm.expiryDate} month="numeric" year="numeric" />,
              balance: formatCurrency(pm.balance, pm.currency),
            }}
          />
        );
      } else {
        return (
          <FormattedMessage
            id="ContributePayment.balanceLeft"
            defaultMessage="{balance} left"
            values={{ balance: formatCurrency(pm.balance, pm.currency) }}
          />
        );
      }
    } else if (['prepaid', 'collective'].includes(pm.type)) {
      return (
        <FormattedMessage
          id="ContributePayment.balanceLeft"
          defaultMessage="{balance} left"
          values={{ balance: formatCurrency(pm.balance, pm.currency) }}
        />
      );
    }
  };

  const paymentMethods = get(data, 'Collective.paymentMethods', null);
  const paymentOptions = React.useMemo(() => {
    if (!paymentMethods) {
      return null;
    }
    const paymentMethodsOptions = paymentMethods.map(pm => ({
      key: `pm-${pm.id}`,
      title: getPaymentMethodName(pm),
      subtitle: getPaymentMethodMetadata(pm),
      icon: getPaymentMethodIcon(pm),
      paymentMethod: pm,
      disabled: pm.balance < minBalance,
      id: pm.id,
      CollectiveId: pm.collective.id,
    }));
    const uniquePMs = uniqBy(paymentMethodsOptions, 'key');
    // put the PM that matches this recurring contribution on top of the list
    const sortedPMs = uniquePMs.sort(a => a.id !== contribution.legacyPaymentMethodId);
    return sortedPMs;
  }, [paymentMethods]);

  useEffect(() => {
    if (paymentOptions && defaultPaymentMethod === null) {
      setDefaultPaymentMethod(first(paymentOptions.filter(option => option.id === contribution.legacyPaymentMethodId)));
      setLoadingDefaultPaymentMethod(false);
    }
  }, [paymentOptions]);

  return (
    <Fragment>
      <Flex width={1} alignItems="center" justifyContent="center" minHeight={45}>
        <P my={2} fontSize="Caption" textTransform="uppercase" color="black.700">
          {showAddPaymentMethod
            ? intl.formatMessage(messages.addPaymentMethod)
            : intl.formatMessage(messages.updatePaymentMethod)}
        </P>
        <Flex flexGrow={1} alignItems="center">
          <StyledHr width="100%" mx={2} />
        </Flex>
        <PlusCircle size={20} onClick={() => setShowAddPaymentMethod(true)} />
      </Flex>
      {showAddPaymentMethod ? (
        <NewCreditCardForm
          name="newCreditCardInfo"
          profileType={'USER'}
          // error={errors.newCreditCardInfo}
          onChange={setNewPaymentMethodInfo}
          onReady={({ stripe }) => setStripe(stripe)}
          hasSaveCheckBox={false}
        />
      ) : loadingDefaultPaymentMethod ? (
        <LoadingPlaceholder height={100} />
      ) : (
        <StyledRadioList
          id="PaymentMethod"
          name="PaymentMethod"
          keyGetter="key"
          options={paymentOptions}
          onChange={setSelectedPaymentMethod}
          defaultValue={defaultPaymentMethod?.key}
          value={selectedPaymentMethod}
        >
          {({ radio, value: { title, subtitle, icon } }) => (
            <PaymentMethodBox minheight={50} p={2} bg="white.full">
              <Flex alignItems="center">
                <Box as="span" mr={3} flexWrap="wrap">
                  {radio}
                </Box>
                <Flex mr={2} css={{ flexBasis: '26px' }}>
                  {icon}
                </Flex>
                <Flex flexDirection="column">
                  <P fontWeight={subtitle ? 600 : 400} color="black.900">
                    {title}
                  </P>
                  {subtitle && (
                    <P fontSize="Caption" fontWeight={400} lineHeight="Caption" color="black.500">
                      {subtitle}
                    </P>
                  )}
                </Flex>
              </Flex>
            </PaymentMethodBox>
          )}
        </StyledRadioList>
      )}
      <Flex flexGrow={1 / 4} width={1} alignItems="center" justifyContent="center">
        <Flex flexGrow={1} alignItems="center">
          <StyledHr width="100%" />
        </Flex>
      </Flex>
      <Flex flexGrow={1 / 4} width={1} alignItems="center" justifyContent="center" minHeight={45}>
        {showAddPaymentMethod ? (
          <Fragment>
            <StyledButton
              buttonSize="tiny"
              onClick={() => {
                setShowAddPaymentMethod(false);
                setNewPaymentMethodInfo(null);
              }}
            >
              {intl.formatMessage(messages.cancel)}
            </StyledButton>
            <StyledButton
              ml={2}
              buttonSize="tiny"
              buttonStyle="secondary"
              disabled={newPaymentMethodInfo ? !newPaymentMethodInfo?.value.complete : true}
              type="submit"
              loading={loadingAddPaymentMethod}
              onClick={async () => {
                if (!stripe) {
                  createNotification(
                    'error',
                    'There was a problem initializing the payment form. Please reload the page and try again',
                  );
                  return false;
                }
                const { token, error } = await stripe.createToken();

                if (error) {
                  createNotification('error', error.message);
                  return false;
                }
                const newStripePaymentMethod = stripeTokenToPaymentMethod(token);
                const newPaymentMethod = pick(newStripePaymentMethod, ['name', 'token', 'data']);
                try {
                  await submitAddPaymentMethod({
                    variables: { newPaymentMethod },
                    refetchQueries: [
                      {
                        query: getPaymentMethodsQuery,
                        variables: { collectiveSlug: router.query.collectiveSlug },
                      },
                    ],
                  });
                  setShowAddPaymentMethod(false);
                } catch (error) {
                  const errorMsg = getErrorFromGraphqlException(error).message;
                  createNotification('error', errorMsg);
                }
              }}
            >
              {intl.formatMessage(messages.save)}
            </StyledButton>
          </Fragment>
        ) : (
          <Fragment>
            <StyledButton
              buttonSize="tiny"
              onClick={() => {
                setMenuState('mainMenu');
              }}
            >
              {intl.formatMessage(messages.cancel)}
            </StyledButton>
            <StyledButton
              ml={2}
              buttonSize="tiny"
              buttonStyle="secondary"
              loading={loadingUpdatePaymentMethod}
              disabled={!selectedPaymentMethod}
              onClick={async () => {
                try {
                  await submitUpdatePaymentMethod({
                    variables: {
                      order: { id: contribution.id },
                      paymentMethod: {
                        legacyId: selectedPaymentMethod.value.paymentMethod.id,
                      },
                    },
                  });
                  createNotification('update');
                  setShowPopup(false);
                } catch (error) {
                  const errorMsg = getErrorFromGraphqlException(error).message;
                  createNotification('error', errorMsg);
                }
              }}
            >
              {intl.formatMessage(messages.update)}
            </StyledButton>
          </Fragment>
        )}
      </Flex>
    </Fragment>
  );
};

UpdatePaymentMethodPopUp.propTypes = {
  data: PropTypes.object,
  setMenuState: PropTypes.func,
  router: PropTypes.object.isRequired,
  contribution: PropTypes.object.isRequired,
  createNotification: PropTypes.func,
  setShowPopup: PropTypes.func,
  loadStripe: PropTypes.func.isRequired,
};

export default withStripeLoader(withRouter(UpdatePaymentMethodPopUp));
